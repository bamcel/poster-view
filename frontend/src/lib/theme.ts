export interface AppTheme {
  name: string;
  window: string;
  card: string;
  panel: string;
  sidebar: string;
  input: string;
  inputHover: string;
  button: string;
  buttonHover: string;
  selected: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  subtle: string;
  disabled: string;
  accent: string;
  accentHover: string;
  success: string;
  warning: string;
}

// Shared with MKV Orchestrator's semantic palette. PosterView-specific Tailwind
// tokens are assigned from these roles by applyTheme below.
export const THEMES: AppTheme[] = [
  { name:"Absolutely", window:"#F6F3EE", card:"#FFFCF8", panel:"#F1ECE5", sidebar:"#E9E3DB", input:"#F4EFE9", inputHover:"#DED2C7", button:"#E8DED4", buttonHover:"#DED2C7", selected:"#F0DDD0", border:"#D6CCC2", borderStrong:"#B9AA9D", text:"#292522", muted:"#655D56", subtle:"#887D74", disabled:"#A79D95", accent:"#C66B43", accentHover:"#AD5835", success:"#347A4A", warning:"#9A6218" },
  { name:"Cappuccin", window:"#1E1E2E", card:"#252538", panel:"#2B2B40", sidebar:"#181825", input:"#313147", inputHover:"#484864", button:"#3B3B54", buttonHover:"#484864", selected:"#403854", border:"#45455F", borderStrong:"#62627C", text:"#CDD6F4", muted:"#BAC2DE", subtle:"#9399B2", disabled:"#6C7086", accent:"#CBA6F7", accentHover:"#B58BE8", success:"#A6E3A1", warning:"#F9E2AF" },
  { name:"Codex", window:"#181A1F", card:"#202329", panel:"#252930", sidebar:"#15171B", input:"#2A2E36", inputHover:"#3A424E", button:"#303640", buttonHover:"#3A424E", selected:"#263C4A", border:"#3A414C", borderStrong:"#566170", text:"#F1F3F5", muted:"#C5CAD1", subtle:"#929AA5", disabled:"#69727E", accent:"#3B9EFF", accentHover:"#2188E8", success:"#42C77A", warning:"#E7B65A" },
  { name:"Everforest", window:"#272E33", card:"#2E383C", panel:"#343F44", sidebar:"#232A2E", input:"#374145", inputHover:"#4B565C", button:"#414B50", buttonHover:"#4B565C", selected:"#3C4F48", border:"#475258", borderStrong:"#68757A", text:"#D3C6AA", muted:"#B7B09A", subtle:"#859289", disabled:"#6D7A72", accent:"#A7C080", accentHover:"#91AD6C", success:"#83C092", warning:"#DBBC7F" },
  { name:"GitHub", window:"#0D1117", card:"#161B22", panel:"#1C2128", sidebar:"#010409", input:"#0D1117", inputHover:"#30363D", button:"#21262D", buttonHover:"#30363D", selected:"#1F3042", border:"#30363D", borderStrong:"#484F58", text:"#E6EDF3", muted:"#B1BAC4", subtle:"#7D8590", disabled:"#6E7681", accent:"#2F81F7", accentHover:"#1F6FEB", success:"#3FB950", warning:"#D29922" },
  { name:"Gotham", window:"#15171C", card:"#20232A", panel:"#252932", sidebar:"#1B1E25", input:"#1D2028", inputHover:"#292E38", button:"#3B4252", buttonHover:"#2E3440", selected:"#2E3440", border:"#3B4252", borderStrong:"#4C566A", text:"#ECEFF4", muted:"#D8DEE9", subtle:"#A7B0C0", disabled:"#7D8797", accent:"#BD93F9", accentHover:"#2E3440", success:"#50FA7B", warning:"#EBCB8B" },
  { name:"Gruvbox", window:"#282828", card:"#32302F", panel:"#3C3836", sidebar:"#1D2021", input:"#3C3836", inputHover:"#665C54", button:"#504945", buttonHover:"#665C54", selected:"#4A4435", border:"#504945", borderStrong:"#7C6F64", text:"#EBDBB2", muted:"#D5C4A1", subtle:"#A89984", disabled:"#7C6F64", accent:"#D79921", accentHover:"#B57614", success:"#98971A", warning:"#FE8019" },
  { name:"Linear", window:"#17171A", card:"#1F1F23", panel:"#25252A", sidebar:"#121214", input:"#29292F", inputHover:"#3A3A44", button:"#303038", buttonHover:"#3A3A44", selected:"#343047", border:"#35353D", borderStrong:"#51515E", text:"#F1F1F3", muted:"#C5C5CC", subtle:"#8B8B96", disabled:"#676771", accent:"#7C6AEF", accentHover:"#6957DC", success:"#4AC58B", warning:"#E0AA55" },
  { name:"Mercy", window:"#F5F6FA", card:"#E8ECF4", panel:"#EEF1F7", sidebar:"#E8ECF4", input:"#E8ECF4", inputHover:"#F1F4FA", button:"#DCE3EF", buttonHover:"#6D5BD0", selected:"#D9DDF0", border:"#CAD2E0", borderStrong:"#9DA8BA", text:"#1C2430", muted:"#46556A", subtle:"#66758A", disabled:"#8792A3", accent:"#6D5BD0", accentHover:"#6D5BD0", success:"#17803D", warning:"#A15C00" },
  { name:"Midnight", window:"#1E1F29", card:"#282A36", panel:"#2B2E3A", sidebar:"#232631", input:"#282A36", inputHover:"#2F3140", button:"#44475A", buttonHover:"#3A3D4F", selected:"#3A3D4F", border:"#343746", borderStrong:"#44475A", text:"#F8F8F2", muted:"#CFCFEA", subtle:"#8B93A7", disabled:"#6272A4", accent:"#BD93F9", accentHover:"#3A3D4F", success:"#50FA7B", warning:"#FFA500" },
  { name:"Notion", window:"#F7F7F5", card:"#FFFFFF", panel:"#F1F1EF", sidebar:"#F0F0EE", input:"#F7F7F5", inputHover:"#DEDEDB", button:"#E9E9E7", buttonHover:"#DEDEDB", selected:"#E3ECF4", border:"#D9D9D6", borderStrong:"#B6B6B2", text:"#252525", muted:"#5F5E5A", subtle:"#85847F", disabled:"#A09F9A", accent:"#0B6E99", accentHover:"#095E83", success:"#448361", warning:"#A66A18" },
  { name:"One", window:"#21252B", card:"#282C34", panel:"#2C313A", sidebar:"#1E2228", input:"#2F343E", inputHover:"#464D59", button:"#3A404B", buttonHover:"#464D59", selected:"#333F55", border:"#3E4451", borderStrong:"#5C6370", text:"#ABB2BF", muted:"#C8CDD5", subtle:"#7F8794", disabled:"#5C6370", accent:"#61AFEF", accentHover:"#4D9BD8", success:"#98C379", warning:"#E5C07B" },
  { name:"Proof", window:"#F4F5F0", card:"#FCFDF9", panel:"#ECEFE8", sidebar:"#E8EBE5", input:"#F2F4EF", inputHover:"#D5DDD7", button:"#E1E6DF", buttonHover:"#D5DDD7", selected:"#DDEAE3", border:"#CED6D0", borderStrong:"#AAB8AF", text:"#26332D", muted:"#52645A", subtle:"#77877E", disabled:"#98A39D", accent:"#3D7660", accentHover:"#315F4D", success:"#3C805A", warning:"#95691F" },
  { name:"Raycast", window:"#171719", card:"#202024", panel:"#27272C", sidebar:"#121214", input:"#2B2B31", inputHover:"#414149", button:"#35353C", buttonHover:"#414149", selected:"#493137", border:"#3D3D44", borderStrong:"#5B5B64", text:"#FAFAFA", muted:"#D0CFD3", subtle:"#929198", disabled:"#6D6C73", accent:"#FF5A67", accentHover:"#E94B58", success:"#55C994", warning:"#E4B45E" },
  { name:"Rose Pine", window:"#191724", card:"#1F1D2E", panel:"#26233A", sidebar:"#14121E", input:"#26233A", inputHover:"#3B3752", button:"#312E45", buttonHover:"#3B3752", selected:"#403044", border:"#393552", borderStrong:"#6E6A86", text:"#E0DEF4", muted:"#C4A7E7", subtle:"#908CAA", disabled:"#6E6A86", accent:"#EB6F92", accentHover:"#D85F82", success:"#9CCFD8", warning:"#F6C177" },
  { name:"Solarized", window:"#FDF6E3", card:"#EEE8D5", panel:"#F7F0DC", sidebar:"#E8E2CF", input:"#F5EEDB", inputHover:"#D2CCB9", button:"#DED8C5", buttonHover:"#D2CCB9", selected:"#DDE8E4", border:"#D0C9B5", borderStrong:"#93A1A1", text:"#073642", muted:"#586E75", subtle:"#839496", disabled:"#A4AAA4", accent:"#B58900", accentHover:"#987400", success:"#2AA198", warning:"#CB4B16" },
  { name:"Vercel", window:"#0A0A0A", card:"#111111", panel:"#171717", sidebar:"#050505", input:"#1A1A1A", inputHover:"#303030", button:"#242424", buttonHover:"#303030", selected:"#16263B", border:"#2E2E2E", borderStrong:"#505050", text:"#EDEDED", muted:"#B7B7B7", subtle:"#888888", disabled:"#666666", accent:"#0070F3", accentHover:"#0060D1", success:"#46A758", warning:"#E5A000" },
  { name:"VS Code Plus", window:"#181818", card:"#1F1F1F", panel:"#252526", sidebar:"#181818", input:"#2A2D2E", inputHover:"#3E3E42", button:"#333337", buttonHover:"#3E3E42", selected:"#24394A", border:"#3C3C3C", borderStrong:"#5A5A5A", text:"#CCCCCC", muted:"#B8B8B8", subtle:"#858585", disabled:"#666666", accent:"#007ACC", accentHover:"#006BB3", success:"#4EC9B0", warning:"#DCDCAA" },
  { name:"Xcode", window:"#F2F4F7", card:"#FFFFFF", panel:"#E9EDF2", sidebar:"#E5E9EF", input:"#F7F8FA", inputHover:"#D2D8E0", button:"#DFE4EA", buttonHover:"#D2D8E0", selected:"#DCEBFA", border:"#CBD1D9", borderStrong:"#A3ABB6", text:"#1F2328", muted:"#505963", subtle:"#747E89", disabled:"#99A1AA", accent:"#006FE6", accentHover:"#005FC7", success:"#348A42", warning:"#A86400" },
];

const STORAGE_KEY = "posterview.theme";

export function applyTheme(name: string) {
  const theme = THEMES.find((candidate) => candidate.name === name) ?? THEMES.find((candidate) => candidate.name === "Gotham")!;
  const root = document.documentElement;
  root.dataset.theme = theme.name;
  root.style.colorScheme = ["Absolutely", "Mercy", "Notion", "Proof", "Solarized", "Xcode"].includes(theme.name) ? "light" : "dark";
  const values: Record<string, string> = {
    base: theme.window, surface: theme.card, "surface-2": theme.panel, sidebar: theme.sidebar,
    input: theme.input, "input-hover": theme.inputHover, button: theme.button,
    "button-hover": theme.buttonHover, elevated: theme.selected, border: theme.border,
    "border-strong": theme.borderStrong, text: theme.text, muted: theme.muted,
    faint: theme.subtle, disabled: theme.disabled, accent: theme.accent,
    "accent-hover": theme.accentHover, success: theme.success, warning: theme.warning,
  };
  for (const [token, value] of Object.entries(values)) root.style.setProperty(`--color-${token}`, value);
  localStorage.setItem(STORAGE_KEY, theme.name);
  return theme.name;
}

export function initializeTheme() {
  return applyTheme(localStorage.getItem(STORAGE_KEY) ?? "Gotham");
}
