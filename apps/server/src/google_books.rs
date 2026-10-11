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
 let mut request=client.get(url).header("X-Goog-Api-Key",key);
 if id.is_none(){request=request.query(&[("q",query),("maxResults","20"),("printType","books")]);}
 let response=request.send().await.map_err(|_|"Google Books connection failed.")?;
 if !response.status().is_success(){return Err(match response.status().as_u16(){401|403=>"Google Books rejected the API key or access. Check that Books API is enabled and key restrictions allow server requests.",429=>"Google Books quota exceeded. Try again later.",404=>"Google Books volume not found.",_=>"Google Books request failed."}.into());}
 response.json().await.map_err(|_|"Invalid Google Books response.".into())
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
 #[test] fn maps_edition_without_inventing_series_counts(){let raw=json!({"id":"a-B_12","volumeInfo":{"title":"Example","authors":["Author"],"publishedDate":"2021-02-09","pageCount":178,"averageRating":4.5,"industryIdentifiers":[{"type":"ISBN_13","identifier":"9781646090716"}]}});let value=fields(&raw);assert_eq!(value["year"],2021);assert_eq!(value["rating"],9.0);assert_eq!(value["isbn_13"],"9781646090716");assert_eq!(value["credits"][0]["category"],"author");assert!(value["volumes"].is_null());assert_eq!(candidate(&raw).unwrap()["id"],"a-B_12");assert!(!valid_id("../secret"));}
 #[tokio::test] async fn key_is_not_returned_and_blank_save_preserves_it(){let temp=tempfile::tempdir().unwrap();let state=crate::native::scan_tests::state(temp.path());let result=save(State(state.clone()),Json(SettingsInput{enabled:true,api_key:Some("test-secret".into()),clear_key:false})).await.unwrap().0;assert_eq!(result,json!({"enabled":true,"configured":true}));let _=save(State(state.clone()),Json(SettingsInput{enabled:false,api_key:Some("".into()),clear_key:false})).await.unwrap();assert_eq!(ServerStore::new(state.runtime.data_dir()).get_setting("google_books_api_key").unwrap(),"test-secret");}
}
