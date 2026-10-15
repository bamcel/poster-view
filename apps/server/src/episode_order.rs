use posterview_contracts::native::NativeCatalogEntry;

/// Project special placement onto playback order without changing episode identity.
pub(crate) fn sort_episodes(episodes: &mut [&NativeCatalogEntry], enabled: bool) {
    episodes.sort_by_key(|entry| {
        let season = entry.metadata["season"].as_i64().unwrap_or(0);
        let episode = entry.metadata["episode"].as_i64().unwrap_or(0);
        let mut placement = (season, episode, 1);
        if enabled && entry.metadata["season"].as_i64() == Some(0) {
            let positive = |key: &str| entry.metadata[key].as_i64().filter(|v| *v > 0);
            if let Some(target) = positive("airs_before_season") {
                placement = (target, positive("airs_before_episode").unwrap_or(1), 0);
            } else if let Some(target) = positive("airs_after_season") {
                placement = (target, i64::MAX, 2);
            }
        }
        (placement, episode, entry.path.as_str(), entry.id.as_str())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn episode(id: &str, metadata: Value) -> NativeCatalogEntry {
        NativeCatalogEntry {
            id: id.into(),
            path: id.into(),
            kind: "episode".into(),
            parent_path: None,
            title: id.into(),
            metadata,
            artwork: vec![],
            files: vec![],
            nfo_path: None,
            nfo_xml: None,
            available: true,
            revision: 0,
        }
    }

    #[test]
    fn special_placement_orders_start_before_episode_and_after_season() {
        let entries = [
            episode(
                "after",
                json!({"season":0,"episode":3,"airs_after_season":1}),
            ),
            episode("second", json!({"season":1,"episode":2})),
            episode(
                "before",
                json!({"season":0,"episode":2,"airs_before_season":1,"airs_before_episode":2}),
            ),
            episode("next", json!({"season":2,"episode":1})),
            episode("first", json!({"season":1,"episode":1})),
            episode(
                "start",
                json!({"season":0,"episode":1,"airs_before_season":1}),
            ),
        ];
        let mut ordered = entries.iter().collect::<Vec<_>>();
        sort_episodes(&mut ordered, true);
        assert_eq!(
            ordered.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["start", "first", "before", "second", "after", "next"]
        );
        sort_episodes(&mut ordered, false);
        assert_eq!(
            ordered.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["start", "before", "after", "first", "second", "next"]
        );
    }

    #[test]
    fn invalid_placement_and_regular_episode_hints_do_not_move_episodes() {
        let entries = [
            episode(
                "regular",
                json!({"season":2,"episode":1,"airs_before_season":1}),
            ),
            episode(
                "invalid",
                json!({"season":0,"episode":1,"airs_before_season":-1,"airs_after_season":0}),
            ),
            episode("missing", json!({"episode":2,"airs_before_season":3})),
            episode("first", json!({"season":1,"episode":1})),
        ];
        let mut ordered = entries.iter().collect::<Vec<_>>();
        sort_episodes(&mut ordered, true);
        assert_eq!(
            ordered.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            ["invalid", "missing", "first", "regular"]
        );
    }
}
