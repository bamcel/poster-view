import {useState} from "react";
import {useIsAdmin} from "../../lib/authContext";
import CollectionCard from "./CollectionCard";
import CollectionMembershipDialog from "./CollectionMembershipDialog";
import {useCollections} from "./client";

export default function CollectionsPage(){const query=useCollections(),admin=useIsAdmin();const [search,setSearch]=useState(""),[create,setCreate]=useState(false);
 return <div className="h-full min-h-0 overflow-y-auto p-4 md:p-8"><header className="mb-6 flex flex-wrap items-center justify-between gap-4"><h1 className="text-2xl font-semibold">Collections</h1>{admin&&<button className="btn-secondary" onClick={()=>setCreate(true)}>Create collection</button>}</header><label className="mb-5 block max-w-md">Search collections<input className="mt-1 w-full rounded border border-border bg-input p-2" value={search} onChange={event=>setSearch(event.target.value)}/></label>{query.isPending&&<p role="status">Loading collections…</p>}{query.error&&<p role="alert">{String(query.error)}</p>}{query.data?.length===0&&<p>No collections yet.{admin&&" Select titles in a library to create one."}</p>}<div className="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">{query.data?.filter(item=>item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(collection=><CollectionCard key={collection.id} collection={collection}/>)}</div>{create&&<CollectionMembershipDialog members={[]} onClose={()=>setCreate(false)}/>}</div>;
}
