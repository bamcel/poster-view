use axum::{extract::State,Json};
use serde::{Deserialize,Serialize};
use crate::{AppState,HttpError};
use posterview_infra_sqlite::ServerStore;
#[derive(Clone,Serialize,Deserialize)]
#[serde(default,deny_unknown_fields)]
pub struct Settings {
 pub hardware_enabled:bool,pub hardware_backend:String,pub preferred_encoder:String,
 pub allow_hevc:bool,pub allow_av1:bool,pub software_fallback:bool,
 pub max_resolution:u32,pub max_concurrent:u32,pub threads:u32,
 pub temporary_path:String,pub cache_gb:u32,pub throttle:bool,pub buffer_seconds:u32,
 pub subtitle_extraction:bool,pub font_extraction:bool,pub audio_boost:f64,
}
impl Default for Settings {fn default()->Self {Self{hardware_enabled:false,hardware_backend:"auto".into(),preferred_encoder:"avc".into(),allow_hevc:false,allow_av1:false,software_fallback:true,max_resolution:1080,max_concurrent:2,threads:0,temporary_path:String::new(),cache_gb:10,throttle:true,buffer_seconds:120,subtitle_extraction:true,font_extraction:true,audio_boost:1.0}}}
impl Settings {fn validate(&self)->Result<(),HttpError> {
 if !["auto","qsv","vaapi","nvenc"].contains(&self.hardware_backend.as_str())||!["avc","hevc","av1"].contains(&self.preferred_encoder.as_str()) {return Err(HttpError::bad_request("Unsupported hardware backend or encoder."));}
 if (self.preferred_encoder=="hevc"&&!self.allow_hevc)||(self.preferred_encoder=="av1"&&!self.allow_av1) {return Err(HttpError::bad_request("Enable the preferred encoder first."));}
 if ![0,480,720,1080,2160].contains(&self.max_resolution)||!(1..=16).contains(&self.max_concurrent)||self.threads>128||!(1..=1024).contains(&self.cache_gb)||!(10..=600).contains(&self.buffer_seconds)||!self.audio_boost.is_finite()||!(1.0..=4.0).contains(&self.audio_boost) {return Err(HttpError::bad_request("Transcoding limits are out of range."));}
 if self.temporary_path.len()>4096||self.temporary_path.contains(['\n','\r','\0'])||(!self.temporary_path.is_empty()&&!std::path::Path::new(&self.temporary_path).is_absolute()) {return Err(HttpError::bad_request("Temporary path must be an absolute server path."));} Ok(())
}}
pub(crate) fn load(state:&AppState)->Result<Settings,HttpError>{let raw=ServerStore::new(state.runtime.data_dir()).get_setting("transcoding-settings").map_err(|e|HttpError::bad_request(e.to_string()))?;if raw.is_empty(){Ok(Settings::default())}else{serde_json::from_str(&raw).map_err(|e|HttpError::bad_request(e.to_string()))}}
pub async fn get(State(state):State<AppState>)->Result<Json<Settings>,HttpError>{Ok(Json(load(&state)?))}
pub async fn save(State(state):State<AppState>,Json(settings):Json<Settings>)->Result<Json<Settings>,HttpError>{settings.validate()?;ServerStore::new(state.runtime.data_dir()).set_setting("transcoding-settings",&serde_json::to_string(&settings).map_err(|e|HttpError::bad_request(e.to_string()))?).map_err(|e|HttpError::bad_request(e.to_string()))?;Ok(Json(settings))}
#[cfg(test)]mod tests{use super::*;#[tokio::test]async fn persists_and_validates(){let temp=tempfile::tempdir().unwrap();let state=crate::test_support::state(temp.path());assert!(!load(&state).unwrap().hardware_enabled);let mut s=Settings::default();s.hardware_enabled=true;s.hardware_backend="nvenc".into();let _ = save(State(state.clone()),Json(s)).await.unwrap();assert_eq!(load(&state).unwrap().hardware_backend,"nvenc");let mut s=Settings::default();s.preferred_encoder="av1".into();assert!(s.validate().is_err());s.allow_av1=true;assert!(s.validate().is_ok());s.max_concurrent=0;assert!(s.validate().is_err());}}
