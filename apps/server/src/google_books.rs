use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use posterview_infra_sqlite::ServerStore;
use crate::{AppState,HttpError};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SettingsInput { enabled: bool, api_key: Option<String>, #[serde(default)] clear_key: bool }
fn status(state:&AppState)->Result<Value,HttpError>{
 let db=ServerStore::new(state.runtime.data_dir());
 let configured=!db.get_setting("google_books_api_key").map_err(|_|HttpError::bad_request("Could not read Google Books settings."))?.is_empty();
 let enabled=db.get_setting("plugin-google-books-enabled").unwrap_or_default()=="true";
 Ok(json!({"enabled":enabled,"configured":configured}))
}
pub(crate) async fn get(State(state):State<AppState>)->Result<Json<Value>,HttpError>{Ok(Json(status(&state)?))}
pub(crate) async fn save(State(state):State<AppState>,Json(input):Json<SettingsInput>)->Result<Json<Value>,HttpError>{
 let db=ServerStore::new(state.runtime.data_dir());
 if let Some(key)=input.api_key.as_ref().filter(|key|!key.trim().is_empty()) {if key.len()>256 || !key.trim().bytes().all(|c|c.is_ascii_alphanumeric()||b"-_".contains(&c)){return Err(HttpError::bad_request("Enter a valid Google Books API key."));}}
 if input.clear_key {db.set_setting("google_books_api_key","").map_err(|_|HttpError::bad_request("Could not remove API key."))?;}else if let Some(key)=input.api_key.filter(|key|!key.trim().is_empty()){db.set_setting("google_books_api_key",key.trim()).map_err(|_|HttpError::bad_request("Could not save API key."))?;}
 db.set_setting("plugin-google-books-enabled",if input.enabled{"true"}else{"false"}).map_err(|_|HttpError::bad_request("Could not save Google Books settings."))?;
 Ok(Json(status(&state)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TestInput { api_key: Option<String> }
pub(crate) async fn test(State(state):State<AppState>,input:Option<Json<TestInput>>)->Result<Json<Value>,HttpError>{
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(|_|HttpError::bad_gateway("Could not create Google Books client."))?;
 let supplied=input.and_then(|value|value.0.api_key).unwrap_or_default();
 let key=if supplied.trim().is_empty(){ServerStore::new(state.runtime.data_dir()).get_setting("google_books_api_key").map_err(|_|HttpError::bad_request("Could not read API key."))?}else{supplied.trim().to_owned()};
 if key.is_empty()||key.len()>256||!key.bytes().all(|c|c.is_ascii_alphanumeric()||b"-_".contains(&c)){return Err(HttpError::bad_request("Enter a valid Google Books API key."));}
 request_with_key(&client,None,"isbn:9780747532699",&key).await.map_err(HttpError::bad_gateway)?;Ok(Json(json!({"message":"Google Books connection successful."})))
}
pub(crate) fn valid_id(id:&str)->bool{!id.is_empty()&&id.len()<=128&&id.bytes().all(|c|c.is_ascii_alphanumeric()||b"-_".contains(&c))}
pub(crate) async fn request(state:&AppState,client:&reqwest::Client,id:Option<&str>,query:&str)->Result<Value,String>{
 let db=ServerStore::new(state.runtime.data_dir());
 if db.get_setting("plugin-google-books-enabled").unwrap_or_default()!="true"{return Err("Enable Google Books in Settings → Plugins.".into());}
 let key=db.get_setting("google_books_api_key").map_err(|_|"Could not read Google Books API key.")?;
 if key.is_empty(){return Err("Connect your API key in Settings → Plugins → Google Books.".into());}
 request_with_key(client,id,query,&key).await
}
async fn request_with_key(client:&reqwest::Client,id:Option<&str>,query:&str,key:&str)->Result<Value,String>{
 if id.is_some_and(|id|!valid_id(id)){return Err("Invalid Google Books volume ID.".into());}
 let url=id.map(|id|format!("https://www.googleapis.com/books/v1/volumes/{id}")).unwrap_or_else(||"https://www.googleapis.com/books/v1/volumes".into());
 let mut request=client.get(url).query(&[("key",key)]);
 if id.is_none(){request=request.query(&[("q",query),("maxResults","20"),("printType","books")]);}
 let response=send_with_retry(request).await?;
 if !response.status().is_success(){let status=response.status().as_u16();let body=response.json::<Value>().await.unwrap_or(Value::Null);return Err(provider_error(status,&body));}
 response.json().await.map_err(|_|"Invalid Google Books response.".into())
}
// Retry transient upstream failures without retrying invalid credentials or quota errors.
async fn send_with_retry(request:reqwest::RequestBuilder)->Result<reqwest::Response,String>{
 for attempt in 0..3 {
  let result=request.try_clone().ok_or("Could not prepare Google Books request.")?.timeout(std::time::Duration::from_secs(6)).send().await;
  let retry=match &result {Ok(response)=>matches!(response.status().as_u16(),500|502|503|504),Err(error)=>error.is_timeout()||error.is_connect()};
  if retry&&attempt<2 {tokio::time::sleep(std::time::Duration::from_millis(500*(attempt+1))).await;continue;}
  return result.map_err(|error|if error.is_timeout(){"Google Books request timed out after retries. Try again.".into()}else{"Could not connect to Google Books. Check the server's internet access.".into()});
 }
 unreachable!()
}
fn provider_error(status:u16,body:&Value)->String{
 let reasons=body["error"]["errors"].as_array().into_iter().flatten().map(|v|v["reason"].as_str().unwrap_or("")).chain(body["error"]["details"].as_array().into_iter().flatten().map(|v|v["reason"].as_str().unwrap_or(""))).collect::<Vec<_>>();
 let message=if reasons.iter().any(|r|["API_KEY_INVALID","keyInvalid"].contains(r)){"Invalid Google Books API key. Replace it in the plugin configuration."}
 else if reasons.iter().any(|r|["SERVICE_DISABLED","accessNotConfigured"].contains(r)){"Books API is not enabled for this Google Cloud project. Enable it and try again."}
 else if reasons.iter().any(|r|["API_KEY_HTTP_REFERRER_BLOCKED","API_KEY_IP_ADDRESS_BLOCKED","API_KEY_SERVICE_BLOCKED","ipRefererBlocked"].contains(r)){"Google Books key restrictions blocked this server. Check API and application restrictions in Google Cloud."}
 else if status==429||reasons.iter().any(|r|["rateLimitExceeded","dailyLimitExceeded","quotaExceeded","RESOURCE_EXHAUSTED"].contains(r)){"Google Books quota exceeded. Check your project's quota or try again later."}
 else {match status{400=>"Google Books rejected the request. Check the API key, title query, or volume ID.",401|403=>"Google Books denied access. Check the key, Books API enablement, restrictions, and quota.",404=>"Google Books volume not found. Enter its volume ID rather than its title.",500..=599=>"Google Books is temporarily unavailable. Try again later.",_=>"Google Books request failed."}};
 format!("{message} (HTTP {status})")
}
pub(crate) fn fields(raw:&Value)->Value{
 let info=&raw["volumeInfo"];
 let mut fields=json!({"title":info["title"],"subtitle":info["subtitle"],"plot":info["description"],"publisher":info["publisher"],"publishers":info["publisher"].as_str().map(|v|vec![v]),"published_date":info["publishedDate"],"year":info["publishedDate"].as_str().and_then(|v|v.get(..4)).and_then(|v|v.parse::<i64>().ok()),"pages":info["pageCount"],"language":info["language"],"genres":info["categories"],"rating":info["averageRating"].as_f64().map(|v|v*2.0),"ratings_count":info["ratingsCount"],"source_url":info["infoLink"],"credits":info["authors"].as_array().into_iter().flatten().filter_map(|name|name.as_str()).map(|name|json!({"name":name,"category":"author","role":"Author"})).collect::<Vec<_>>()});
 for value in info["industryIdentifiers"].as_array().into_iter().flatten(){if let Some(kind)=value["type"].as_str(){if ["ISBN_10","ISBN_13"].contains(&kind){fields[kind.to_ascii_lowercase()]=value["identifier"].clone();}}}
 fields.as_object_mut().unwrap().retain(|_,v|!v.is_null());fields
}
pub(crate) fn candidate(raw:&Value)->Option<Value>{let id=raw["id"].as_str()?;if !valid_id(id){return None;}let fields=fields(raw);Some(json!({"provider":"googlebooks","id":id,"title":fields["title"].as_str()?,"year":fields["year"],"overview":fields["plot"],"format":"Book edition","publisher":fields["publisher"],"poster":raw["volumeInfo"]["imageLinks"]["thumbnail"].as_str().map(|url|url.replacen("http://","https://",1)),"identifiers":{"googlebooks":id}}))}
#[cfg(test)] mod tests {
 use super::*;
 #[tokio::test] async fn retries_transient_failure_but_not_credentials_or_quota(){
  use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
  for status in [503u16,502,403,429] {
   let calls=Arc::new(AtomicUsize::new(0));let counter=calls.clone();
   let app=axum::Router::new().route("/",axum::routing::get(move || {let counter=counter.clone();async move {
    let call=counter.fetch_add(1,Ordering::SeqCst);
    (axum::http::StatusCode::from_u16(if status==503&&call==2 {200}else{status}).unwrap(),axum::Json(json!({"items":[{"id":"IXzjCwAAQBAJ","volumeInfo":{"title":"Black Clover, Vol. 1"}}]})))
   }}));
   let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
   let server=tokio::spawn(async move {axum::serve(listener,app).await.unwrap()});
   let response=send_with_retry(reqwest::Client::new().get(format!("http://{address}/"))).await.unwrap();
   assert_eq!(calls.load(Ordering::SeqCst),if matches!(status,502|503) {3}else{1});
   assert_eq!(response.status().as_u16(),if status==503 {200}else{status});
   if status==503 {let raw=response.json::<Value>().await.unwrap();assert_eq!(candidate(&raw["items"][0]).unwrap()["id"],"IXzjCwAAQBAJ");}
   server.abort();
  }
 }
 #[test] fn provider_errors_explain_failures_without_exposing_keys(){
  assert!(provider_error(400,&json!({"error":{"details":[{"reason":"API_KEY_INVALID"}]}})).contains("Invalid Google Books API key"));
  assert!(provider_error(403,&json!({"error":{"errors":[{"reason":"accessNotConfigured"}]}})).contains("not enabled"));
  assert!(provider_error(403,&json!({"error":{"details":[{"reason":"API_KEY_HTTP_REFERRER_BLOCKED"}]}})).contains("restrictions"));
  assert!(provider_error(503,&Value::Null).contains("temporarily unavailable"));
  assert!(!provider_error(400,&json!({"error":{"message":"key=secret-fixture"}})).contains("secret-fixture"));
 }

 #[test] fn maps_edition_without_inventing_series_counts(){let raw=json!({"id":"a-B_12","volumeInfo":{"title":"Example","authors":["Author"],"publishedDate":"2021-02-09","pageCount":178,"averageRating":4.5,"industryIdentifiers":[{"type":"ISBN_13","identifier":"9781646090716"}]}});let value=fields(&raw);assert_eq!(value["year"],2021);assert_eq!(value["rating"],9.0);assert_eq!(value["isbn_13"],"9781646090716");assert_eq!(value["credits"][0]["category"],"author");assert!(value["volumes"].is_null());assert_eq!(candidate(&raw).unwrap()["id"],"a-B_12");assert!(!valid_id("../secret"));}
 #[tokio::test] async fn key_is_not_returned_and_blank_save_preserves_it(){let temp=tempfile::tempdir().unwrap();let state=crate::native::scan_tests::state(temp.path());let result=save(State(state.clone()),Json(SettingsInput{enabled:true,api_key:Some("test-secret".into()),clear_key:false})).await.unwrap().0;assert_eq!(result,json!({"enabled":true,"configured":true}));let _=save(State(state.clone()),Json(SettingsInput{enabled:false,api_key:Some("".into()),clear_key:false})).await.unwrap();assert_eq!(ServerStore::new(state.runtime.data_dir()).get_setting("google_books_api_key").unwrap(),"test-secret");}
}
