// DealForge service worker: shows pushed alerts and confirms the display to the server (delivery log "angezeigt").
self.addEventListener('push',e=>{
  const m=e.data?e.data.json():{title:'DealForge',body:''};
  e.waitUntil(self.registration.showNotification(m.title,{body:m.body,tag:m.tag,data:{url:m.url||'/'}}).then(()=>m.deliveryId&&fetch('/api/v1/push/receipts',
    {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Dealforge-Action':'1'},body:JSON.stringify({deliveryId:m.deliveryId})}).catch(()=>{})));
});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.openWindow(e.notification.data?.url||'/'));});
