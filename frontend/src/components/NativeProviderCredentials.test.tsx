import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { apiRequest } from "../api/client";
import NativeProviderCredentials from "./NativeProviderCredentials";
vi.mock("../api/client", () => ({apiRequest: vi.fn()}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
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
  await waitFor(()=>expect((screen.getByRole("button",{name:"Test MyAnimeList"}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button",{name:"Test MyAnimeList"}));
  expect(await screen.findByText("Provider connection succeeded.")).toBeTruthy();
});
