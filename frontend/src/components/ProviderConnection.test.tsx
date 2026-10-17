import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it} from "vitest";
import ProviderConnection from "./ProviderConnection";
beforeEach(()=>{localStorage.clear();sessionStorage.clear();});afterEach(cleanup);
const props={id:"tmdb",name:"TMDB",description:"Movies",setupUrl:"https://example.com"};
it("keeps successful verification across remounts and clears it on credential edits",()=>{
 const view=render(<ProviderConnection {...props} status="Connection verified"><input aria-label="Token"/></ProviderConnection>);
 expect(screen.getByRole("img",{name:"TMDB connection verified"})).toBeTruthy();
 view.unmount();const next=render(<ProviderConnection {...props} status="Credentials saved"><input aria-label="Token"/></ProviderConnection>);
 expect(screen.getByRole("img",{name:"TMDB connection verified"})).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Configure TMDB"}));fireEvent.change(screen.getByLabelText("Token"),{target:{value:"replacement"}});
 expect(screen.queryByRole("img")).toBeNull();next.unmount();
 render(<ProviderConnection {...props} status="Credentials saved">Fields</ProviderConnection>);expect(screen.queryByRole("img")).toBeNull();
});
it("retains a check while retesting but removes it on failure and credential removal",()=>{
 const view=render(<ProviderConnection {...props} status="Connection verified">Fields</ProviderConnection>);
 view.rerender(<ProviderConnection {...props} status="Testing…">Fields</ProviderConnection>);expect(screen.getByRole("img")).toBeTruthy();
 view.rerender(<ProviderConnection {...props} status="Connection failed">Fields</ProviderConnection>);expect(screen.queryByRole("img")).toBeNull();
 view.rerender(<ProviderConnection {...props} status="Connection verified">Fields</ProviderConnection>);expect(screen.getByRole("img")).toBeTruthy();
 view.rerender(<ProviderConnection {...props} status="Not configured">Fields</ProviderConnection>);expect(screen.queryByRole("img")).toBeNull();
});
