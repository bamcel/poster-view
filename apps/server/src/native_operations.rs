use std::{collections::HashMap,sync::{Arc,Mutex,OnceLock}};
use tokio::sync::Notify;
#[derive(Default)]
struct Coordinator { active:Mutex<HashMap<u64,(String,Vec<String>)>>,changed:Notify }
fn coordinator()->Arc<Coordinator>{static VALUE:OnceLock<Arc<Coordinator>>=OnceLock::new();VALUE.get_or_init(Default::default).clone()}
fn overlaps(a:&str,b:&str)->bool{a.is_empty()||b.is_empty()||a==b||a.starts_with(&format!("{b}/"))||b.starts_with(&format!("{a}/"))}
pub(crate) struct Guard {owner:Arc<Coordinator>,id:u64}
impl Drop for Guard {fn drop(&mut self){self.owner.active.lock().unwrap().remove(&self.id);self.owner.changed.notify_waiters();}}
pub(crate) async fn acquire(key:String,scopes:Option<&[String]>)->Guard {
 let owner=coordinator();let paths=scopes.map(<[String]>::to_vec).unwrap_or_else(||vec![String::new()]);
 loop {
  let changed=owner.changed.notified();tokio::pin!(changed);changed.as_mut().enable();
  {let mut active=owner.active.lock().unwrap();
   if !active.values().any(|(other,roots)|other==&key&&paths.iter().any(|a|roots.iter().any(|b|overlaps(a,b)))) {
    static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(1);
    let id=NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed);active.insert(id,(key.clone(),paths.clone()));return Guard{owner:owner.clone(),id};
   }
  }
  changed.await;
 }
}
pub(crate) fn same_manual_fields(a:&serde_json::Value,b:&serde_json::Value)->bool {
 fn manual(value:&serde_json::Value)->serde_json::Value {
  let mut result=serde_json::Map::new();
  for (field,source) in value["_sources"].as_object().into_iter().flatten(){if source=="manual" {result.insert(field.clone(),value[field].clone());}}
  serde_json::Value::Object(result)
 }
 manual(a)==manual(b)
}
#[cfg(test)] mod tests {use super::*;
 #[test] fn revision_rebase_preserves_other_users_manual_changes(){
 let before=serde_json::json!({"plot":"Old","title":"Title","_sources":{"plot":"anilist","title":"manual"}});
 let scanned=serde_json::json!({"plot":"New","title":"Title","_sources":{"plot":"anilist","title":"manual"}});
 assert!(same_manual_fields(&before,&scanned));
 let edited=serde_json::json!({"plot":"New","title":"Changed","_sources":{"plot":"anilist","title":"manual"}});
 assert!(!same_manual_fields(&before,&edited));
 }
 #[tokio::test] async fn full_scan_waits_for_edits_and_other_libraries_continue(){
 let key=uuid::Uuid::new_v4().to_string();let edit=acquire(key.clone(),Some(&["A".into()])).await;
 assert!(tokio::time::timeout(std::time::Duration::from_millis(20),acquire(key.clone(),None)).await.is_err());
 let _other=acquire(format!("{key}-other"),None).await;drop(edit);let _scan=acquire(key,None).await;
 }
 #[tokio::test] async fn unrelated_series_can_run_while_overlapping_changes_wait(){
 let key=uuid::Uuid::new_v4().to_string();let first=acquire(key.clone(),Some(&["Anime/A".into()])).await;
 let second=tokio::time::timeout(std::time::Duration::from_secs(1),acquire(key.clone(),Some(&["Anime/B".into()]))).await.unwrap();
 assert!(tokio::time::timeout(std::time::Duration::from_millis(20),acquire(key.clone(),Some(&["Anime/A/Season 1".into()]))).await.is_err());
 drop(first);let _third=acquire(key,Some(&["Anime/A".into()])).await;drop(second);
 }
}
