import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import YtdlCookieSettings from "./YtdlCookieSettings";
import {ytdlCookies} from "./client";
vi.mock("./client",()=>({ytdlCookies:{status:vi.fn(),save:vi.fn(),remove:vi.fn()}}));
beforeEach(()=>{vi.mocked(ytdlCookies.status).mockResolvedValue({configured:false,updated_at:null});vi.mocked(ytdlCookies.save).mockResolvedValue({configured:true,updated_at:"2026-10-17T10:00:00Z"});vi.mocked(ytdlCookies.remove).mockResolvedValue({configured:false,updated_at:null});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
function mount(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><YtdlCookieSettings/></QueryClientProvider>);}
function choose(contents="private session contents"){const file=new File([contents],"youtube.txt",{type:"text/plain"});Object.defineProperty(file,"text",{value:async()=>contents});fireEvent.change(screen.getByLabelText("YouTube cookie file"),{target:{files:[file]}});}
it("imports locally and sends credentials only after save, clearing selected secrets afterwards",async()=>{
 mount();await screen.findByText("No cookies configured");choose();await screen.findByText(/youtube.txt selected/);
 expect(ytdlCookies.save).not.toHaveBeenCalled();expect(screen.queryByText("private session contents")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Save cookies"}));
 await waitFor(()=>expect(ytdlCookies.save).toHaveBeenCalledWith("private session contents"));await screen.findByText("Cookies saved.");
 expect(screen.queryByText(/youtube.txt selected/)).toBeNull();expect((screen.getByRole("button",{name:"Replace cookies"}) as HTMLButtonElement).disabled).toBe(true);
});
it("removes configured cookies and updates status",async()=>{
 vi.mocked(ytdlCookies.status).mockResolvedValue({configured:true,updated_at:null});mount();await screen.findByText("Cookies configured");
 fireEvent.click(screen.getByRole("button",{name:"Remove cookies"}));await screen.findByText("Cookies removed.");expect(ytdlCookies.remove).toHaveBeenCalledOnce();expect(screen.getByText("No cookies configured")).toBeTruthy();
});
it("shows save errors and leaves the file available for deliberate retry",async()=>{
 vi.mocked(ytdlCookies.save).mockRejectedValue(new Error("Invalid cookie file"));mount();choose();await screen.findByText(/youtube.txt selected/);fireEvent.click(screen.getByRole("button",{name:"Save cookies"}));expect((await screen.findByRole("alert")).textContent).toBe("Invalid cookie file");expect(screen.getByText(/youtube.txt selected/)).toBeTruthy();
});
it("shows removal errors without claiming cookies were removed",async()=>{
 vi.mocked(ytdlCookies.status).mockResolvedValue({configured:true,updated_at:null});vi.mocked(ytdlCookies.remove).mockRejectedValue(new Error("Removal failed"));mount();await screen.findByText("Cookies configured");fireEvent.click(screen.getByRole("button",{name:"Remove cookies"}));expect((await screen.findByRole("alert")).textContent).toBe("Removal failed");expect(screen.getByText("Cookies configured")).toBeTruthy();
});
it("rejects oversized files before reading session contents",async()=>{
 mount();const read=vi.fn();const file=new File([""],"large.txt");Object.defineProperty(file,"size",{value:1024*1024+1});Object.defineProperty(file,"text",{value:read});fireEvent.change(screen.getByLabelText("YouTube cookie file"),{target:{files:[file]}});expect((await screen.findByRole("alert")).textContent).toContain("1 MiB");expect(read).not.toHaveBeenCalled();expect(ytdlCookies.save).not.toHaveBeenCalled();
});
it("does not report unconfigured credentials when status cannot be fetched",async()=>{
 vi.mocked(ytdlCookies.status).mockRejectedValue(new Error("Status unavailable"));mount();expect(await screen.findByText("Authentication status unavailable")).toBeTruthy();expect(screen.queryByText("No cookies configured")).toBeNull();
});
