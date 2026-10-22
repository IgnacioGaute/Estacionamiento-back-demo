const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve('../estacionamiento-front-demo/public');

test('operación completa en navegador sin red, persistencia y pantalla móvil', async () => {
  const server = http.createServer((req,res) => {
    const pathname = new URL(req.url,'http://localhost').pathname;
    if (pathname.startsWith('/api/')) { res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({message:'Servidor sin conexión'}));return; }
    const file = path.join(publicDir,pathname === '/' ? 'offline.html' : pathname.slice(1));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) {res.writeHead(404);res.end();return;}
    res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await puppeteer.launch({headless:true});
  try {
    const page=await browser.newPage(), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);
    await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
    await page.waitForFunction(()=>navigator.serviceWorker.controller);
    const result=await page.evaluate(async()=>{
      const {makeOperation,applyOperation,summary}=await import('/offline-operations.js');
      const capturedAt=new Date(Math.floor(Date.now()/1000)*1000).toISOString(), cajaId=crypto.randomUUID();
      let s={version:2,operationVersion:3,modalidad:'CON_COBRO',role:'ADMIN',userId:crypto.randomUUID(),operatorName:'Ana Offline',playaId:crypto.randomUUID(),deviceId:crypto.randomUUID(),sessionId:crypto.randomUUID(),capturedAt,expiresAt:Date.now()+86400000,shiftsEnabled:true,salary:0,types:[{code:'AUTO',name:'Auto'}],cards:[{id:crypto.randomUUID(),codeBar:'1001',vehicleType:'AUTO'}],vehicles:[],passes:[],passPrices:[{ticketTimeType:'DIA',vehicleType:'AUTO',ticketTimePrice:500}],pending:[],receipts:[],receiptDelivery:{print:true,qr:true},business:{name:'Playa Prueba'},cash:{active:null,cajas:[{id:cajaId,nombre:'Principal',activa:true,principal:true,fondoObjetivo:200,session:null,operadores:[],efectivoDisponible:0}],multipleShiftsEnabled:false,efectivoDisponible:0},pricing:{version:1,capturedAt,schedule:{dayStartHour:8,dayEndHour:20,graceMinutes:0,pricingDayTypeBasis:'ENTRY'},brackets:[{id:'one',vehicleType:'AUTO',ticketDayType:null,label:'Hora',uptoMinutes:null,price:1000,recurringUnitMinutes:null}]}};
      const apply=(action,id,data)=>{const op=makeOperation(s,action,id,data);s=applyOperation(s,op);return op;};
      const assert=(value,message)=>{if(!value)throw new Error(message);};
      const shift=crypto.randomUUID();apply('SHIFT_OPEN',shift,{cajaId,fondoInicial:100,cambioAgregado:0,motivoApertura:'Fondo'});
      const id=crypto.randomUUID();apply('PLATE_ENTRY',id,{licensePlate:'AB123CD',vehicleType:'AUTO'});
      apply('ADVANCE',id,{advancePaidAmount:300,metodo:'CASH'});
      apply('DISCOUNT',id,{monto:100,motivo:'Convenio',expectedPrice:1000,expectedCollected:300});
      apply('PARTIAL_CASH',id,{importe:200,expectedPrice:900,expectedCollected:300});
      apply('CLOSE',id,{closeType:'PAYMENT',expectedPrice:900,expectedCollected:500,pagos:[{metodo:'CASH',importe:100},{metodo:'TRANSFER',importe:300}]});
      assert(s.cash.active.efectivoDisponible===700,'Caja de pago mixto incorrecta');
      const p=crypto.randomUUID();apply('PASS_ENTRY',p,{vehiclePlateCustomer:'ABONO',vehicleType:'AUTO',ticketTimeType:'DIA',days:1,paid:false,paymentMetodo:'CASH'});apply('PASS_UPDATE',p,{paid:true,retired:true,paymentMetodo:'CASH'});
      apply('BOX_MOVEMENT',crypto.randomUUID(),{type:'EGRESOS',price:100,paymentMethod:'CASH',description:'Insumos'});
      apply('CASH_MOVEMENT',s.cash.active.cashSessionId,{tipo:'RETIRO',importe:50,motivo:'Retiro',efectivoEsperado:1100});
      assert(s.cash.active.efectivoDisponible===1050,'Saldo de caja incorrecto');
      apply('SHIFT_CLOSE',shift,{cerrarCaja:true,efectivoEsperado:1050,efectivoContado:1050,efectivoParaSiguiente:200,sueldoEsperado:0});
      assert(s.cash.active===null && s.cash.cajas[0].pending.efectivoParaSiguiente===200,'Cierre incorrecto');
      apply('SHIFT_OPEN',crypto.randomUUID(),{cajaId,fondoInicial:200,cambioAgregado:0,sesionAnteriorId:s.cash.cajas[0].pending.id});
      const refund=crypto.randomUUID();apply('PLATE_ENTRY',refund,{noPlate:true,lastNameCustomer:'García',vehicleType:'AUTO'});apply('ADVANCE',refund,{advancePaidAmount:1200,metodo:'CASH'});apply('CLOSE',refund,{closeType:'NO_CHARGE',expectedPrice:1000,expectedCollected:1200,refundMetodo:'CASH'});
      const card=crypto.randomUUID();apply('CARD_ENTRY',card,{ticketId:s.cards[0].id});
      assert(s.vehicles.find(v=>v.id===card).entryMode==='BARCODE','Tarjeta incorrecta');
      const before=JSON.stringify(s);
      let failed=false;try{apply('DISCOUNT',card,{monto:2000,motivo:'Error',expectedPrice:1000,expectedCollected:0});}catch{failed=true;}
      assert(failed && JSON.stringify(s)===before,'Una operación inválida modificó el estado');
      assert(summary(s,s.vehicles.find(v=>v.id===card)).price===1000,'Tarifa incorrecta');
      const vault=await import('/offline-vault.js');
      await vault.saveOperations(s,'offline-operations-test-password');await vault.rememberDeviceAccess('offline-operations-test-password');
      window.fixture=s;
      return {pending:s.pending.length,cash:s.cash.active.efectivoDisponible};
    });
    assert.equal(result.pending,16);assert.equal(result.cash,1200);
    await page.setOfflineMode(true);
    await page.reload();await page.waitForSelector('#offline-extra');
    await page.waitForFunction(()=>!document.querySelector('#sync').disabled);
    await page.evaluate(()=>[...document.querySelectorAll('#rows button')].find(b=>b.textContent==='Ver opciones').click());
    await page.waitForSelector('dialog.operation-dialog[open]');
    for(const width of [320,390,1280]) {
      await page.setViewport({width,height:850});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Desborde de página a '+width);
      assert.equal(await page.$eval('dialog[open]',d=>d.scrollWidth<=d.clientWidth+1),true,'Desborde del diálogo a '+width);
    }
    await page.setViewport({width:390,height:850});
    fs.mkdirSync(path.resolve('.tmp'),{recursive:true});
    await page.screenshot({path:path.resolve('.tmp/offline-operations-390.png'),fullPage:true});
    await page.evaluate(()=>document.querySelector('dialog[open]').close());
    await page.select('#entry-mode','NAME');
    await page.click('#entry button');await page.waitForSelector('dialog[open] #operation-lastNameCustomer');
    await page.type('#operation-lastNameCustomer','Rodríguez');
    await page.click('dialog[open] button[type=submit]');
    await page.waitForFunction(()=>document.querySelector('#rows').textContent.includes('Rodríguez'));
    await page.reload();await page.waitForFunction(()=>document.querySelector('#rows').textContent.includes('Rodríguez'));
    assert.deepEqual(errors,[]);
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
