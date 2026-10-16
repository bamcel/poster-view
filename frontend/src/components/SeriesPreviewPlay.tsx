import SeriesBannerPlay, {type SeriesPlayProps} from "./SeriesBannerPlay";

export default function SeriesPreviewPlay(props: SeriesPlayProps) {
  return <div className="pv-series-preview-play"><SeriesBannerPlay {...props} variant="preview"/></div>;
}
