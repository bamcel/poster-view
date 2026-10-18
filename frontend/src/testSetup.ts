if(typeof HTMLDialogElement!=="undefined"){
// jsdom does not implement native modal dialogs. Browser tests verify top-layer
// behavior; unit tests need open/close and the initial focus contract.
HTMLDialogElement.prototype.showModal=function(){
 this.setAttribute("open","");
 this.querySelector<HTMLElement>("[autofocus],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]")?.focus();
};
HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};

}
