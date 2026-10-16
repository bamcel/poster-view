use super::Channel;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAX_PROGRAMS: usize = 100_000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(super) struct Candidate {
    pub library_id: String,
    pub item_id: String,
    pub title: String,
    pub series_title: Option<String>,
    pub series_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    #[serde(default)]
    pub placement: Option<(i64, i64, u8)>,
    pub duration_seconds: f64,
    pub artwork_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct Program {
    pub id: String,
    pub library_id: String,
    pub item_id: String,
    pub title: String,
    pub series_title: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub starts_at: String,
    pub ends_at: String,
    pub artwork_url: Option<String>,
}

// Specify our own stable hash and PRNG: neither Rust's process-random hash seeds
// nor the clock may change a channel's published sequence.
struct Random(u64);
impl Random {
    fn new(channel: &Channel) -> Self {
        let mut seed = 0xcbf29ce484222325_u64;
        for byte in channel.id.bytes().chain(
            channel
                .schedule_revision
                .unwrap_or(channel.revision)
                .to_le_bytes(),
        ) {
            seed ^= u64::from(byte);
            seed = seed.wrapping_mul(0x100000001b3);
        }
        Self(seed)
    }

    fn index(&mut self, length: usize) -> usize {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut value = self.0;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d049bb133111eb);
        ((value ^ (value >> 31)) % length as u64) as usize
    }
}

fn ordered(channel: &Channel, mut candidates: Vec<Candidate>) -> Result<Vec<Candidate>, String> {
    candidates.sort_by(|a, b| {
        (
            a.series_title.as_deref().unwrap_or(&a.title),
            a.placement
                .unwrap_or((a.season.unwrap_or(0), a.episode.unwrap_or(0), 1)),
            a.episode,
            &a.title,
            &a.library_id,
            &a.item_id,
        )
            .cmp(&(
                b.series_title.as_deref().unwrap_or(&b.title),
                b.placement
                    .unwrap_or((b.season.unwrap_or(0), b.episode.unwrap_or(0), 1)),
                b.episode,
                &b.title,
                &b.library_id,
                &b.item_id,
            ))
    });
    let mut random = Random::new(channel);
    match channel.order.as_str() {
        "sequential" => Ok(candidates),
        "random" => {
            for index in (1..candidates.len()).rev() {
                let other = random.index(index + 1);
                candidates.swap(index, other);
            }
            Ok(candidates)
        }
        "random_shows" => {
            let mut groups: BTreeMap<(String, String), Vec<Candidate>> = BTreeMap::new();
            for candidate in candidates.into_iter().rev() {
                let key = (
                    candidate.library_id.clone(),
                    candidate
                        .series_id
                        .clone()
                        .unwrap_or_else(|| candidate.item_id.clone()),
                );
                groups.entry(key).or_default().push(candidate);
            }
            let mut groups: Vec<Vec<Candidate>> = groups.into_values().collect();
            let mut result = Vec::new();
            while !groups.is_empty() {
                let index = random.index(groups.len());
                if let Some(candidate) = groups[index].pop() {
                    result.push(candidate);
                }
                if groups[index].is_empty() {
                    groups.remove(index);
                }
            }
            Ok(result)
        }
        _ => Err("Unsupported Virtual TV ordering mode".into()),
    }
}

struct Cycle {
    candidates: Vec<Candidate>,
    durations: Vec<i64>,
    cursor: DateTime<Utc>,
    number: i64,
}

fn prepare(
    channel: &Channel,
    mut candidates: Vec<Candidate>,
    now: DateTime<Utc>,
) -> Result<Cycle, String> {
    candidates.retain(|item| item.season != Some(0) || item.placement.is_some());
    if candidates.is_empty() || candidates.len() > 10_000 {
        return Err("A Virtual TV channel must contain between 1 and 10,000 playable items".into());
    }
    for item in &candidates {
        if !item.duration_seconds.is_finite()
            || item.duration_seconds < 1.0
            || item.duration_seconds > 604_800.0
        {
            return Err(format!(
                "{} needs a valid duration between one second and seven days",
                item.title
            ));
        }
    }
    let anchor = DateTime::parse_from_rfc3339(&channel.start_at)
        .map_err(|_| "Virtual TV start time must be RFC3339".to_owned())?
        .with_timezone(&Utc);
    let candidates = ordered(channel, candidates)?;
    let durations: Vec<i64> = candidates
        .iter()
        .map(|item| (item.duration_seconds * 1000.0).round() as i64)
        .collect();
    let cycle_ms: i64 = durations.iter().sum();
    let elapsed = now.signed_duration_since(anchor).num_milliseconds().max(0);
    let cycle = elapsed / cycle_ms;
    let cursor = anchor
        .checked_add_signed(Duration::milliseconds(cycle * cycle_ms))
        .ok_or("Channel timeline exceeds supported range")?;
    Ok(Cycle {
        candidates,
        durations,
        cursor,
        number: cycle,
    })
}

fn program(
    channel: &Channel,
    item: &Candidate,
    cycle: i64,
    index: usize,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Program {
    Program {
        id: format!(
            "{}:{}:{cycle}:{index}",
            channel.id,
            channel.schedule_revision.unwrap_or(channel.revision)
        ),
        library_id: item.library_id.clone(),
        item_id: item.item_id.clone(),
        title: item.title.clone(),
        series_title: item.series_title.clone(),
        season: item.season,
        episode: item.episode,
        starts_at: start.to_rfc3339_opts(SecondsFormat::Millis, true),
        ends_at: end.to_rfc3339_opts(SecondsFormat::Millis, true),
        artwork_url: item.artwork_url.clone(),
    }
}

/// Resolve live playback directly without allocating an entire guide.
pub(super) fn current_program(
    channel: &Channel,
    candidates: Vec<Candidate>,
    now: DateTime<Utc>,
) -> Result<Option<Program>, String> {
    let Cycle {
        candidates,
        durations,
        mut cursor,
        number,
    } = prepare(channel, candidates, now)?;
    if cursor > now {
        return Ok(None);
    }
    for (index, item) in candidates.iter().enumerate() {
        let end = cursor
            .checked_add_signed(Duration::milliseconds(durations[index]))
            .ok_or("Channel timeline exceeds supported range")?;
        if end > now {
            return Ok(Some(program(channel, item, number, index, cursor, end)));
        }
        cursor = end;
    }
    Ok(None)
}

/// Build a seven-day guide from an immutable repeating cycle anchored to the
/// channel's start. Jump directly to the relevant cycle, even for old channels.
/// The first returned program can already be in progress.
pub(super) fn generate(
    channel: &Channel,
    candidates: Vec<Candidate>,
    now: DateTime<Utc>,
) -> Result<Vec<Program>, String> {
    let until = now
        .checked_add_signed(Duration::days(7))
        .ok_or("Guide time exceeds supported range")?;
    generate_range(channel, candidates, now, until)
}

/// Generate only programs intersecting the requested half-open window. A
/// bounded window keeps guide requests cheap without changing program IDs.
pub(super) fn generate_range(
    channel: &Channel,
    candidates: Vec<Candidate>,
    from: DateTime<Utc>,
    until: DateTime<Utc>,
) -> Result<Vec<Program>, String> {
    let window = until.signed_duration_since(from);
    if window <= Duration::zero() || window > Duration::days(7) {
        return Err("Guide windows must be positive and no longer than seven days".into());
    }
    let Cycle {
        candidates,
        durations,
        mut cursor,
        number: mut cycle_number,
    } = prepare(channel, candidates, from)?;
    let mut programs = Vec::new();
    while cursor < until {
        for (index, item) in candidates.iter().enumerate() {
            let end = cursor
                .checked_add_signed(Duration::milliseconds(durations[index]))
                .ok_or("Channel timeline exceeds supported range")?;
            if end > from && cursor < until {
                if programs.len() == MAX_PROGRAMS {
                    return Err(
                        "Virtual TV guide exceeds 100,000 programs; choose longer content".into(),
                    );
                }
                programs.push(program(channel, item, cycle_number, index, cursor, end));
            }
            cursor = end;
            if cursor >= until {
                break;
            }
        }
        cycle_number += 1;
    }
    Ok(programs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(order: &str) -> Channel {
        Channel {
            id: "channel".into(),
            name: "Test".into(),
            number: 1,
            library_ids: vec!["library".into()],
            collection_ids: vec![],
            show_ids: vec![],
            movie_ids: vec![],
            genres: vec![],
            order: order.into(),
            start_at: "2020-01-01T00:00:00Z".into(),
            revision: 1,
            schedule_revision: None,
        }
    }

    fn item(id: &str, show: &str, episode: i64) -> Candidate {
        Candidate {
            library_id: "library".into(),
            item_id: id.into(),
            title: id.into(),
            series_title: Some(show.into()),
            series_id: Some(show.into()),
            season: Some(1),
            episode: Some(episode),
            placement: None,
            duration_seconds: 3600.0,
            artwork_url: None,
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-16T00:30:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn unplaced_specials_are_ignored_and_placed_specials_follow_episode_order() {
        let first = item("first", "A", 1);
        let second = item("second", "A", 2);
        let mut unplaced = item("unplaced", "A", 9);
        unplaced.season = Some(0);
        let mut placed = item("placed", "A", 1);
        placed.season = Some(0);
        placed.placement = Some((1, 2, 0));
        let items = vec![second, unplaced, placed, first];
        let ordered = ordered(&channel("sequential"), items.clone()).unwrap();
        assert_eq!(
            ordered
                .iter()
                .filter(|p| p.item_id != "unplaced")
                .map(|p| p.item_id.as_str())
                .collect::<Vec<_>>(),
            ["first", "placed", "second"]
        );
        for mode in ["sequential", "random", "random_shows"] {
            let guide = generate(&channel(mode), items.clone(), now()).unwrap();
            assert!(!guide.iter().any(|p| p.item_id == "unplaced"));
            assert!(guide.iter().any(|p| p.item_id == "placed"));
        }
    }

    #[test]
    fn guide_is_contiguous_and_includes_current_program() {
        let result = generate(&channel("sequential"), vec![item("one", "A", 1)], now()).unwrap();
        assert!(DateTime::parse_from_rfc3339(&result[0].starts_at).unwrap() < now());
        assert!(DateTime::parse_from_rfc3339(&result[0].ends_at).unwrap() > now());
        for pair in result.windows(2) {
            assert_eq!(pair[0].ends_at, pair[1].starts_at);
        }
        assert!(
            DateTime::parse_from_rfc3339(&result.last().unwrap().ends_at).unwrap()
                >= now() + Duration::days(7)
        );
    }

    #[test]
    fn range_contains_only_intersecting_programs_with_stable_identity() {
        let items = vec![item("one", "A", 1), item("two", "A", 2)];
        let from = now();
        let until = from + Duration::hours(2);
        let range = generate_range(&channel("random"), items.clone(), from, until).unwrap();
        let full = generate(&channel("random"), items, from).unwrap();
        assert_eq!(range.len(), 3);
        assert_eq!(
            serde_json::to_value(&range).unwrap(),
            serde_json::to_value(&full[..3]).unwrap()
        );
        let boundary = DateTime::parse_from_rfc3339("2026-10-16T01:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let range = generate_range(
            &channel("sequential"),
            vec![item("one", "A", 1)],
            boundary,
            boundary + Duration::hours(1),
        )
        .unwrap();
        assert_eq!(range.len(), 1);
        assert_eq!(
            DateTime::parse_from_rfc3339(&range[0].starts_at).unwrap(),
            boundary
        );
        assert_eq!(
            DateTime::parse_from_rfc3339(&range[0].ends_at).unwrap(),
            boundary + Duration::hours(1)
        );
    }

    #[test]
    fn guide_range_rejects_empty_reversed_or_excessive_windows() {
        for until in [
            now(),
            now() - Duration::seconds(1),
            now() + Duration::days(7) + Duration::seconds(1),
        ] {
            assert!(
                generate_range(
                    &channel("sequential"),
                    vec![item("one", "A", 1)],
                    now(),
                    until
                )
                .is_err()
            );
        }
    }

    #[test]
    fn refresh_and_candidate_input_order_do_not_reshuffle() {
        let channel = channel("random");
        let items = vec![item("a", "A", 1), item("b", "A", 2), item("c", "B", 1)];
        let first = generate(&channel, items.clone(), now()).unwrap();
        let mut reversed = items;
        reversed.reverse();
        let second = generate(&channel, reversed, now() + Duration::minutes(1)).unwrap();
        assert_eq!(first[0].id, second[0].id);
        assert_eq!(first[0].starts_at, second[0].starts_at);
        assert_eq!(
            first.iter().map(|p| &p.item_id).collect::<Vec<_>>(),
            second.iter().map(|p| &p.item_id).collect::<Vec<_>>()
        );
    }

    #[test]
    fn sequential_and_random_shows_preserve_episode_order() {
        let items = vec![
            item("b2", "B", 2),
            item("a2", "A", 2),
            item("b1", "B", 1),
            item("a1", "A", 1),
        ];
        let sequence = ordered(&channel("sequential"), items.clone()).unwrap();
        assert_eq!(
            sequence
                .iter()
                .map(|p| p.item_id.as_str())
                .collect::<Vec<_>>(),
            ["a1", "a2", "b1", "b2"]
        );
        let sequence = ordered(&channel("random_shows"), items).unwrap();
        for show in ["A", "B"] {
            assert_eq!(
                sequence
                    .iter()
                    .filter(|p| p.series_id.as_deref() == Some(show))
                    .map(|p| p.episode.unwrap())
                    .collect::<Vec<_>>(),
                [1, 2]
            );
        }
    }

    #[test]
    fn exact_end_excludes_previous_program() {
        let at = now() + Duration::minutes(30);
        let result = generate(&channel("sequential"), vec![item("one", "A", 1)], at).unwrap();
        assert_eq!(
            DateTime::parse_from_rfc3339(&result[0].starts_at).unwrap(),
            at
        );
    }

    #[test]
    fn current_program_matches_guide_across_boundaries_and_order_modes() {
        let items = vec![item("a1", "A", 1), item("a2", "A", 2), item("b1", "B", 1)];
        for order in ["sequential", "random", "random_shows"] {
            for offset in [-1, 0, 1, 3599, 3600, 3601, 10799, 10800] {
                let at = DateTime::parse_from_rfc3339("2026-10-16T00:00:00Z")
                    .unwrap()
                    .with_timezone(&Utc)
                    + Duration::seconds(offset);
                let current = current_program(&channel(order), items.clone(), at)
                    .unwrap()
                    .unwrap();
                let guide = generate(&channel(order), items.clone(), at).unwrap();
                assert_eq!(
                    serde_json::to_value(current).unwrap(),
                    serde_json::to_value(&guide[0]).unwrap()
                );
            }
        }
        let mut future = channel("sequential");
        future.start_at = (now() + Duration::hours(1)).to_rfc3339();
        assert!(current_program(&future, items, now()).unwrap().is_none());
    }

    #[test]
    fn future_start_has_no_program_before_anchor() {
        let mut channel = channel("sequential");
        channel.start_at = (now() + Duration::hours(2)).to_rfc3339();
        let result = generate(&channel, vec![item("one", "A", 1)], now()).unwrap();
        assert_eq!(
            DateTime::parse_from_rfc3339(&result[0].starts_at).unwrap(),
            now() + Duration::hours(2)
        );
    }

    #[test]
    fn invalid_duration_and_oversized_guides_fail_explicitly() {
        for duration in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut candidate = item("bad", "A", 1);
            candidate.duration_seconds = duration;
            assert!(generate(&channel("sequential"), vec![candidate], now()).is_err());
        }
        let mut candidate = item("short", "A", 1);
        candidate.duration_seconds = 1.0;
        assert!(
            generate(&channel("sequential"), vec![candidate], now())
                .unwrap_err()
                .contains("100,000")
        );
    }
}
