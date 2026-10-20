export const MEDIA_SOURCE_OPTIONS=[
  {value:"",label:"Unknown"},
  {value:"bluray",label:"Blu-ray"},
  {value:"bd",label:"BD"},
  {value:"uhd-bluray",label:"UHD Blu-ray"},
  {value:"dvd",label:"DVD"},
  {value:"web-dl",label:"WEB-DL"},
  {value:"webrip",label:"WEBRip"},
  {value:"hdtv",label:"HDTV"},
  {value:"mixed",label:"Mixed"},
  {value:"other",label:"Other"},
] as const;

export function mediaSourceLabel(value:unknown):string|undefined {
  return typeof value==="string"&&value?MEDIA_SOURCE_OPTIONS.find(option=>option.value===value)?.label:undefined;
}
