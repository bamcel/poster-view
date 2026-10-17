import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { apiRequest } from "../api/client";
import NativeProviderCredentials from "./NativeProviderCredentials";
vi.mock("../api/client", () => ({apiRequest: vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();localStorage.clear();sessionStorage.clear();});
it("saves new provider credentials without showing saved secrets and tests saved configuration",async()=>{
  let configured=false;
  vi.mocked(apiRequest).mockImplementation(async (path, input)=>{
    if(path.includes("/test/"))return {ok:true,message:"Provider connection succeeded."};
    if(input?.method==="PUT")configured=true;
    return {mal_configured:configured,omdb_configured:false,anidb_client:"",anidb_client_version:""};
  });
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><NativeProviderCredentials /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button",{name:"Configure MyAnimeList"}));
  const input=await screen.findByLabelText("MyAnimeList Client ID");
  fireEvent.change(input,{target:{value:"fixture-client"}});
  fireEvent.click(screen.getByRole("button",{name:"Save MyAnimeList"}));
  await waitFor(()=>expect(apiRequest).toHaveBeenCalledWith("/native/providers/settings",{method:"PUT",body:JSON.stringify({mal_client_id:"fixture-client"})}));
  await waitFor(()=>expect((input as HTMLInputElement).value).toBe(""));
  await waitFor(()=>expect((screen.getByRole("button",{name:"Test Connection"}) as HTMLButtonElement).disabled).toBe(false));
  await waitFor(()=>expect((screen.getByRole("button",{name:"Test Connection"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Test Connection"}));
  expect(await screen.findByText("Provider connection succeeded.")).toBeTruthy();
});

it("hides OMDb unless its plugin is enabled",async()=>{
 vi.mocked(apiRequest).mockResolvedValue({mal_configured:false,omdb_configured:true,omdb_enabled:false});
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
 render(<QueryClientProvider client={client}><NativeProviderCredentials/></QueryClientProvider>);
 await screen.findByRole("button",{name:"Configure MyAnimeList"});
 expect(screen.queryByRole("button",{name:"Configure OMDb"})).toBeNull();
 vi.mocked(apiRequest).mockResolvedValue({mal_configured:false,omdb_configured:true,omdb_enabled:true});
 await client.invalidateQueries({queryKey:["native-provider-settings"]});
 expect(await screen.findByRole("button",{name:"Configure OMDb"})).toBeTruthy();
});

it("scopes connection results to each provider and clears success when credentials change",async()=>{
  vi.mocked(apiRequest).mockImplementation(async path=>path.includes("/test/")?{ok:true,message:"Provider connection succeeded."}:{mal_configured:true,omdb_configured:true,omdb_enabled:true});
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><NativeProviderCredentials /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button",{name:"Configure MyAnimeList"}));
  fireEvent.click(await screen.findByRole("button",{name:"Configure OMDb"}));
  const mal=within(screen.getByRole("region",{name:"MyAnimeList connection"}));
  const omdb=within(screen.getByRole("region",{name:"OMDb connection"}));
  await waitFor(()=>expect((mal.getByRole("button",{name:"Test Connection"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(mal.getByRole("button",{name:"Test Connection"}));
  expect(await mal.findByRole("img",{name:"MyAnimeList connection verified"})).toBeTruthy();
  expect(omdb.queryByRole("img",{name:"OMDb connection verified"})).toBeNull();
  fireEvent.change(mal.getByLabelText("MyAnimeList Client ID"),{target:{value:"replacement"}});
  expect(mal.queryByRole("img",{name:"MyAnimeList connection verified"})).toBeNull();
});

it("removes a successful connection check when a later test fails",async()=>{
  let succeeds=true;
  vi.mocked(apiRequest).mockImplementation(async path=>path.includes("/test/")?{ok:succeeds,message:succeeds?"Verified":"Rejected"}:{mal_configured:true,omdb_configured:false});
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><NativeProviderCredentials /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button",{name:"Configure MyAnimeList"}));
  await waitFor(()=>expect((screen.getByRole("button",{name:"Test Connection"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Test Connection"}));
  expect(await screen.findByRole("img",{name:"MyAnimeList connection verified"})).toBeTruthy();
  succeeds=false;
  await waitFor(()=>expect((screen.getByRole("button",{name:"Test Connection"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Test Connection"}));
  expect(await screen.findByText("Connection failed")).toBeTruthy();
  expect(screen.queryByRole("img",{name:"MyAnimeList connection verified"})).toBeNull();
});
