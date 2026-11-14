import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const context={window:{}};
vm.runInNewContext(readFileSync('public/admin-dashboard.js','utf8'),context);
const data=rows=>JSON.parse(JSON.stringify(context.window.AdminDashboard.crimeData(rows)));
assert.deepEqual(data([]),{slices:[],breakdown:[],total:0,grouped:false});
assert.equal(data(null).total,0);
const small=data([{k:'Theft',n:3},{k:'Fraud',n:2},{k:'Assault',n:1}]);
assert.equal(small.grouped,false);
assert.equal(small.slices.length,3);
assert.equal(small.total,6);
assert.equal(small.slices.reduce((sum,item)=>sum+item.value,0),6);
const rows=[
  {k:'Theft',n:9},{k:'Fraud',n:4},{k:'Assault',n:4},
  {k:'Traffic accident',n:2},{k:'Suspicious activity',n:1},
  {k:'Other',n:1},{k:'Vandalism',n:0}
];
const original=JSON.stringify(rows);
const grouped=data(rows);
assert.equal(JSON.stringify(rows),original,'Chart grouping must not mutate live state');
assert.equal(grouped.grouped,true);
assert.equal(grouped.total,21);
assert.equal(grouped.slices.length,3);
assert.deepEqual(grouped.slices.map(item=>item.name),['Theft','Assault','Remaining types']);
assert.deepEqual(grouped.slices.map(item=>item.value),[9,4,8]);
assert.equal(grouped.breakdown.reduce((sum,item)=>sum+item.value,0),21);
assert(grouped.breakdown.some(item=>item.name==='Fraud'&&item.value===4));
assert.equal(data([{k:'Theft',n:0}]).slices.length,0,'Zero totals must not produce fake pie slices');
console.log('PASS: actual crime-type counts, empty states, three-colour grouping, stable ties, complete totals and unchanged input');
