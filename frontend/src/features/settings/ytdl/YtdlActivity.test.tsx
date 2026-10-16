import {cleanup,fireEvent,render,screen,within} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import YtdlActivity from "./YtdlActivity";
import {activeYtdlJob,ytdlPhase} from "./jobPresentation";
import type {YtdlJob} from "./client";
afterEach(cleanup);
const job=(id:string,status:string,extra:Partial<YtdlJob>={}):YtdlJob=>({id,title:id,url:"https://youtube.com/watch?v=id",status,progress:50,speed:null,eta:null,error:null,created_at:"",settings:{directory:"youtube",video_codec:"auto",container:"mkv"} as YtdlJob["settings"],...extra});
it("shows running jobs before queued items and keeps completed history collapsed",()=>{
 render(<YtdlActivity jobs={[job("old","completed"),job("waiting","queued"),job("running","downloading")]} loading={false} busy={false} onRemove={vi.fn()} onAction={vi.fn()}/>);
 const regions=screen.getAllByRole("region");expect(regions[0].getAttribute("aria-label")).toBe("Running jobs");expect(regions[1].getAttribute("aria-label")).toBe("Queued jobs");
 const history=screen.getByText("History (1)").closest("details")!;expect(history.open).toBe(false);
});
it("distinguishes outcomes and retries only failed videos with original job identity",()=>{
 const action=vi.fn();render(<YtdlActivity jobs={[job("playlist","completed_with_warnings",{total_videos:7,completed_videos:7,downloaded_videos:2,existing_videos:3,updated_videos:0,skipped_videos:1,failed_videos:1,failed_entries:[{video_id:"blocked",title:"Restricted video",error:"Age verification required"}]})]} loading={false} busy={false} onRemove={vi.fn()} onAction={action}/>);
 expect(screen.getByText("7 of 7 videos processed")).toBeTruthy();expect(screen.getByText("2 downloaded")).toBeTruthy();expect(screen.getByText("3 already present")).toBeTruthy();expect(screen.getByText("1 failed")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Retry failed videos"}));expect(action).toHaveBeenCalledWith("playlist","retry-failed");expect(activeYtdlJob("completed_with_warnings")).toBe(false);
});
it("labels metadata work accurately and keeps cancellation and removal available",()=>{
 const action=vi.fn(),remove=vi.fn();render(<YtdlActivity jobs={[job("metadata","importing",{metadata_only:true})]} loading={false} busy={false} onRemove={remove} onAction={action}/>);
 const running=screen.getByRole("region",{name:"Running jobs"});expect(within(running).getByText("Updating metadata")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Cancel"}));expect(action).toHaveBeenCalledWith("metadata","cancel");fireEvent.click(screen.getByRole("button",{name:"Remove metadata"}));expect(remove).toHaveBeenCalledWith("metadata");
 expect(ytdlPhase(job("video","importing"))).toBe("Writing metadata");
});
