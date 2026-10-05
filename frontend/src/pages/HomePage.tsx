import {Navigate,useSearchParams} from "react-router-dom";
import DashboardPage from "./DashboardPage";
export default function HomePage(){
 const [params]=useSearchParams();
 if(params.has("native_library")) return <Navigate replace to={`/media/${encodeURIComponent(params.get("native_library")!)}?${params}`}/>;
 if(params.has("lib")) return <DashboardPage/>;
 return <div className="h-full p-6"><h1 className="text-2xl font-semibold">Home</h1></div>;
}
