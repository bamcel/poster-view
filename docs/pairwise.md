# PairWise Ranking

Enable **PairWise Ranking** in **Settings → Plugins**, then open its sidebar page.
Administrators control whether the plugin is enabled; every signed-in account can
rank its own permitted native movie, TV, Korean, and Anime libraries.

Select a library and choose **Start ranking**. All available movies and series titles are included automatically. Seasons,
episodes, alternate video versions, missing catalog entries, books, YouTube, and collection containers are
not separate candidates. A library needs at least two included titles.

Choose either poster or its Choose button, **About equal**, or **Skip pair**.
Every saved answer immediately persists the next comparison. **Pause / View
rankings** leaves the current pair available for another session or device.
**Undo last decision** restores the previous decision and, when still available,
its comparison. Stale browser tabs reload before accepting another choice.

**Don’t rank this title** covers unwatched titles and anything else you prefer
to leave out. It is available before starting and on each comparison card.
Excluded titles stay under **Not ranked — excluded by you**, outside the scoring
and pairing pool. **Allow ranking** restores eligibility and previous choices.
Skip changes neither title's preference. Repeating a matchup replaces its current
choice rather than counting repeated answers as extra votes.

## Scores and comparisons

The model is L2-regularized Bradley–Terry with Davidson tie probabilities. A fixed
draw weight of one avoids fitting a draw parameter from very sparse personal
data. Each unique current pair contributes one observation. A displayed score is
the model's mean predicted preference against other compared titles, with draws
counting half: `100 × mean(P(win) + 0.5 × P(tie))`. It is a relative personal
preference within this library, not a review rating or a percentage confidence.
The model follows the family described in [Efficient Computation of Rankings
from Pairwise Comparisons](https://jmlr.org/papers/v24/22-1086.html).

Uncompared titles have no score or position. Rankings are provisional until they
have enough different opponents (up to three, adjusted for small libraries) and
the compared titles form a connected comparison graph. This is a coverage
indicator, not a statistical guarantee. Equal modeled strengths use stable title
IDs to break display-order ties.

Pair selection prioritizes coverage and connecting separate groups, then closeness
and lightly compared titles. Recent pairs are discouraged when alternatives exist.
Left/right placement varies. There is no requirement to compare every possible
pair or to finish the whole library before viewing results.

Computation is bounded to 120 fitting iterations. Preference scores use all
compared opponents through 512 ranked titles; larger rankings use a deterministic
512-title reference sample. Pair selection uses a bounded candidate pool, including
the least-compared titles. Scores and positions are recalculated as choices and
eligible titles change. The comparison count reflects distinct current matchups
among included, currently visible titles.

## Storage and access

Private boards are keyed by authenticated account and library in SQLite migration
7. Revision checks and opaque pair tokens reject stale or duplicate submissions.
The decision history preserves undo and exclusions, while catalog rescans do not
overwrite it. Library and parental permissions are checked on every request,
including mutations, scores, counts, and undo. Hidden/removed titles do not appear
in projections or affect current scores. Disabling the plugin preserves boards.
Deleting an account or library cascades its boards.

Serialization and model calculation happen outside the short coordinated SQLite
write transaction. The initial implementation recalculates rankings per request;
it does not launch background jobs for individual choices. A board is bounded to
100,000 history events and 32 MiB of serialized data. No provider metadata or
external service is needed.
