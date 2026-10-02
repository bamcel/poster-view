# DeviantArt artwork source

In Settings → Search Providers, register/save credentials for a confidential DeviantArt application and use Test Connection. PosterView stores the client ID and secret encrypted on the server and returns only a configured flag. Public browsing uses a cached client-credentials token in the Authorization header; user sign-in is not required.

DeviantArt appears in the artwork panel for screen and book libraries, and may be selected as the default source. The item title prefills the tag search. Spaces and punctuation are removed: `Akame ga Kill!` becomes `akamegakill`. Edit the tag to find alternatives. Results use pages of 50 deviations and show image titles, artist usernames, and links to the original artwork. Mature and non-image results are excluded. Landscape images appear under Backgrounds; other images appear under Posters. Custom targets remain available.

Apply uses the same replacement workflow as other artwork sources, including optional manual-library media-folder saving and connected-server synchronization. Browsing does not change metadata, provider IDs, or server artwork. DeviantArt is not used for automatic identification or scan-time metadata enrichment.

Image downloads and redirects are restricted to HTTPS on DeviantArt's image domains. Search results use the frontend's five-minute query cache, rather than the long-lived on-disk provider cache, to avoid retaining signed image URLs. Tokens are reused until shortly before expiry; credential changes invalidate that token identity.

API reference: https://deviantart.readme.io/reference/browse_tags
Authentication: https://deviantart.readme.io/docs/authentication
