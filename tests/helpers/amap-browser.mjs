// The only browser replacement is the external high-level AMap SDK boundary.
// The DOM below makes the coordinates and individual paths given to that SDK observable.
export const amapBrowserScript = `(() => {
  class Map {
    constructor(element) { this.element = element; this.handlers = {}; this.element.dataset.sdkMap = 'ready'; this.click = (event) => { if (!event.target.closest('button')) this.handlers.click?.({lnglat:{lng:119.2,lat:32.1}}); }; element.addEventListener('click',this.click); }
    on(event,handler) { this.handlers[event]=handler; }
    off(event) { delete this.handlers[event]; }
    add(items) { for (const item of items) { if (item.element) this.element.appendChild(item.element); } }
    remove(items) { for (const item of items) item.element?.remove(); }
    setFitView() {}
    destroy() { this.element.removeEventListener('click',this.click); this.element.replaceChildren(); delete this.element.dataset.sdkMap; }
  }
  class Marker {
    constructor(options) { this.element=document.createElement('div');this.element.dataset.sdkMarker=JSON.stringify(options.position); if(options.content) this.element.appendChild(options.content); }
    on(event,handler) { this.element.addEventListener(event,handler); }
    off(event,handler) { this.element.removeEventListener(event,handler); }
  }
  class Polyline { constructor(options) { this.element=document.createElement('div');this.element.dataset.sdkPolyline=JSON.stringify(options.path); } }
  class MarkerCluster {
    constructor(map,points) { this.element=document.createElement('div');this.element.dataset.sdkCluster=String(points.length);map.element.appendChild(this.element); }
    setMap(map) { if(!map)this.element.remove(); }
    on() {}
  }
  class AutoComplete {
    search(keyword,callback) { setTimeout(() => callback('complete',{tips:keyword.includes('无坐标')?[{name:'没有具体坐标的地区',location:''}]:[{id:'shanghai',name:keyword.includes('迟到')?'迟到地点':'上海搜索仓',district:'上海市',location:{lng:121.47,lat:31.23}}]}),keyword.includes('迟到')?1000:20); }
  }
  class PlaceSearch {
    search(keyword,callback) { setTimeout(()=>callback('complete',{poiList:{pois:[{id:'nanjing',name:'南京搜索客户',location:{lng:118.79,lat:32.06}}]}}),20); }
    getDetails(id,callback) { this.search(id,callback); }
  }
  window.AMap={Map,Marker,Polyline,MarkerCluster,AutoComplete,PlaceSearch,Pixel:class {constructor(x,y){this.x=x;this.y=y;}},plugin:(names,callback)=>callback()};
  window.___onAPILoaded();
})();`;

export async function replaceAmapSDK(page) {
  await page.route('https://webapi.amap.com/maps?**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: amapBrowserScript }));
}
