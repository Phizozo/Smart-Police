'use strict';
(() => {
  let charts = [];
  const palette = ['#ec4899','#facc15','#a855f7'];
  const safeNumber = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const compareNames = (a,b) => a < b ? -1 : a > b ? 1 : 0;

  function crimeData(rawTypes) {
    const breakdown = (Array.isArray(rawTypes) ? rawTypes : [])
      .map(item => ({name:String(item?.k ?? ''),value:safeNumber(item?.n)}))
      .sort((a,b)=>compareNames(a.name,b.name));
    const total = breakdown.reduce((sum,item)=>sum+item.value,0);
    const nonzero = breakdown.filter(item=>item.value>0);
    if (!total) return {slices:[],breakdown,total:0,grouped:false};
    if (nonzero.length<=3) return {slices:nonzero.map(item=>({...item})),breakdown,total,grouped:false};
    const ranked=[...nonzero].sort((a,b)=>b.value-a.value||compareNames(a.name,b.name));
    const leaders=ranked.slice(0,2);
    const remaining=ranked.slice(2);
    return {
      slices:[
        {...leaders[0]},
        {...leaders[1]},
        {name:'Remaining types',value:remaining.reduce((sum,item)=>sum+item.value,0)}
      ],
      breakdown,
      total,
      grouped:true
    };
  }

  function summaryRoleValues(summary, stats) {
    const raw=summary?.activeUsersByRole ?? summary?.active_users_by_role ?? summary?.usersByRole;
    let entries=[];
    if(Array.isArray(raw)) entries=raw.map(item=>[String(item.role??item.k??item.name??''),safeNumber(item.count??item.n??item.value)]);
    else if(raw&&typeof raw==='object') entries=Object.entries(raw).map(([name,value])=>[name,safeNumber(typeof value==='object'?value.count??value.n??value.value:value)]);
    const counts=new Map(entries.map(([name,value])=>[name.toLowerCase().replace(/s$/,''),value]));
    const fields=[
      ['Citizens','citizen','activeCitizens'],
      ['Officers','officer','activeOfficers'],
      ['Admins','admin','activeAdmins']
    ];
    return fields.map(([name,key,field])=>({
      name,
      value:counts.has(key)?counts.get(key):safeNumber(stats[field]),
      color:palette[fields.findIndex(item=>item[1]===key)]
    }));
  }

  function columnOption(data) {
    return {
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter(params){
        if(!params)return '';
        const rows=Array.isArray(params)?params:[params];
        return rows.map(item=>`${escape(item.axisValueLabel??item.name??'')}: ${safeNumber(item.value)}`).join('<br>');
      }},
      grid:{left:18,right:20,top:18,bottom:34,containLabel:true},
      xAxis:{type:'category',data:data.map(item=>item.name),axisLabel:{color:'#000',interval:0,hideOverlap:true},axisLine:{lineStyle:{color:'#888'}}},
      yAxis:{type:'value',min:0,minInterval:1,axisLabel:{color:'#000'},splitLine:{lineStyle:{color:'#d0d0d0'}}},
      series:[{type:'bar',data:data.map(item=>({value:item.value,itemStyle:{color:item.color}})),barMaxWidth:62,label:{show:true,position:'top',color:'#000',formatter:p=>String(safeNumber(p.value))}}]
    };
  }

  function pieOption(data) {
    const counts=new Map(data.slices.map(item=>[item.name,item.value]));
    return {
      tooltip:{trigger:'item',formatter(params){
        if(!params)return '';
        return `${escape(params.name)}: ${safeNumber(params.value)}`;
      }},
      legend:{
        type:'scroll',
        orient:'horizontal',
        bottom:0,
        textStyle:{color:'#000'},
        formatter(name){return `${escape(name)}: ${safeNumber(counts.get(name))}`;}
      },
      series:[{
        type:'pie',
        radius:'62%',
        center:['50%','43%'],
        avoidLabelOverlap:true,
        data:data.slices.map((item,index)=>({name:item.name,value:item.value,itemStyle:{color:palette[index%palette.length]}})),
        label:{show:true,color:'#000',formatter(params){return `${String(params.name)}: ${safeNumber(params.value)}`}},
        labelLine:{lineStyle:{color:'#555'}},
        emphasis:{scale:true,scaleSize:5}
      }]
    };
  }

  function mount(state) {
    dispose();
    const status=Array.isArray(state?.stats?.status)?state.stats.status:[];
    const statusWrap=document.querySelector('#admin-cases-status');
    if(statusWrap){
      if(!status.length)statusWrap.innerHTML='<p class="meta">No case status counts are available.</p>';
      else{
        const max=Math.max(1,...status.map(item=>safeNumber(item.n)));
        statusWrap.innerHTML=`<div class="admin-status-bars">${status.map(item=>`<div class="admin-status-item"><span>${escape(item.k)}</span><div class="bar"><span class="sr-only">${safeNumber(item.n)} cases</span><i style="width:${safeNumber(item.n)/max*100}%"></i><b>${safeNumber(item.n)}</b></div></div>`).join('')}</div>`;
      }
    }
    const stats=state?.stats||{};
    const roleData=summaryRoleValues(state?.adminSummary||{},stats);
    const roleNode=document.getElementById('admin-users-chart');
    const roleList=document.getElementById('admin-users-chart-counts');
    if(roleList)roleList.innerHTML=roleData.map(item=>`<li>${escape(item.name)}: <strong>${item.value}</strong></li>`).join('');
    if(roleNode){
      if(!window.echarts)roleNode.innerHTML='<p role="alert">Graphs could not load. Current counts are shown below.</p>';
      else{
        const chart=echarts.init(roleNode,null,{renderer:'canvas'});
        chart.setOption(columnOption(roleData));
        charts.push(chart);
      }
    }

    const crime=crimeData(stats.type);
    const crimeNode=document.getElementById('admin-crime-chart');
    const crimeCaption=document.getElementById('admin-crime-caption');
    const crimeList=document.getElementById('admin-crime-chart-counts');
    if(crimeList)crimeList.innerHTML=crime.breakdown.length
      ?crime.breakdown.map(item=>`<li>${escape(item.name)}: <strong>${item.value}</strong></li>`).join('')
      :'<li>No crime type counts are available.</li>';
    if(crimeCaption){
      crimeCaption.textContent=crime.total===0
        ?'No crimes recorded yet.'
        :crime.grouped
          ?`Largest two types shown individually; “Remaining types” combines the other ${crime.slices.length ? crime.breakdown.filter(item=>item.value>0).length-2 : 0} incident types (${crime.slices[2].value} cases). Full counts are listed below.`
          :'Each non-zero incident type is shown individually. Full counts are listed below.';
    }
    if(crimeNode){
      if(crime.total===0){crimeNode.setAttribute('aria-label','No crimes recorded yet.');crimeNode.innerHTML='<p class="meta">No crimes recorded yet.</p>';}
      else if(!window.echarts){crimeNode.setAttribute('aria-label','Crime type graph unavailable; full counts are listed below.');crimeNode.innerHTML='<p role="alert">Graphs could not load. Current counts are shown below.</p>';}
      else{
        crimeNode.setAttribute('aria-label',crime.slices.map(item=>`${item.name}: ${item.value}`).join('; '));
        const chart=echarts.init(crimeNode,null,{renderer:'canvas'});
        chart.setOption(pieOption(crime));
        charts.push(chart);
      }
    }
    window.addEventListener('resize',resize,{passive:true});
  }
  function resize(){charts.forEach(chart=>chart.resize());}
  function dispose(){window.removeEventListener('resize',resize);charts.forEach(chart=>chart.dispose());charts=[];}
  window.AdminDashboard={mount,dispose,crimeData,escape};
})();
