import HeaderSearchControl from "../../components/HeaderSearchControl";
import {ACTION_BUTTON} from "../../components/ui";
import SearchField from "../../components/SearchField";
import {useState} from "react";
import {useIsAdmin} from "../../lib/authContext";
import CollectionCard from "./CollectionCard";
import CollectionMembershipDialog from "./CollectionMembershipDialog";
import {useCollections} from "./client";

export default function CollectionsPage(){const query=useCollections(),admin=useIsAdmin();const [search,setSearch]=useState(""),[create,setCreate]=useState(false);
 return <div className="h-full min-h-0 overflow-y-auto px-4 pb-4 pt-5 md:px-8 md:pb-8"><header className="mb-6 flex flex-wrap items-center justify-between gap-4"><h1 className="text-2xl font-semibold">Collections</h1>{admin&&<button className={ACTION_BUTTON} onClick={()=>setCreate(true)}>Create collection</button>}</header><HeaderSearchControl><div className="w-full max-w-[21rem]"><SearchField aria-label="Search collections" value={search} onChange={event=>setSearch(event.target.value)}/></div></HeaderSearchControl>{query.isPending&&<p role="status">Loading collections…</p>}{query.error&&<p role="alert">{String(query.error)}</p>}{query.data?.length===0&&<p>No collections yet.{admin&&" Select titles in a library to create one."}</p>}<div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">{query.data?.filter(item=>item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(collection=><CollectionCard key={collection.id} collection={collection}/>)}</div>{create&&<CollectionMembershipDialog members={[]} onClose={()=>setCreate(false)}/>}</div>;
}
