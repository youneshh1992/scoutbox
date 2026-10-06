import { useEffect, type ReactNode } from 'react';
import { Icon } from './icons';

/** Observe the actual scroll viewport, including the workspace's nested scroller.
 * Nothing is hidden until an observer exists; reduced-motion users keep all content. */
export function AgentMotion() {
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    let dispose = () => {};
    const start = () => {
      dispose();
      if (preference.matches || !('IntersectionObserver' in window)) return;
      const tracked = new Set<Element>();
      const observer = new IntersectionObserver(entries => {
        entries.forEach(({target,isIntersecting}) => {
          if (!isIntersecting) return;
          target.classList.remove('a-motion-pending');
          target.classList.add('a-entered');
          observer.unobserve(target);
        });
      }, {threshold:0.08, rootMargin:'0px 0px -24px 0px'});
      const scan = () => {
        document.querySelectorAll('.a-card,.a-kpi,.agent-finance .stat,.a-section,.a-opportunity-v2,.a-person-card,.a-credential-card,.a-business-hero,.a-login-map,.a-bell-item,.a-compliance-desk .section').forEach(el => {
          if (tracked.has(el)) return;
          tracked.add(el);
          el.classList.add('a-motion-pending');
          observer.observe(el);
        });
        // Route changes remove old records; don't retain detached DOM nodes.
        for (const el of tracked) if (!el.isConnected) { observer.unobserve(el); tracked.delete(el); }
      };
      const mutations = new MutationObserver(scan);
      mutations.observe(document.body,{childList:true,subtree:true});
      scan();
      dispose = () => { observer.disconnect();mutations.disconnect();tracked.forEach(el=>el.classList.remove('a-motion-pending','a-entered'));tracked.clear(); };
    };
    start();preference.addEventListener('change',start);
    return () => { dispose();preference.removeEventListener('change',start); };
  },[]);
  return null;
}

export function AgentTabs<T extends string>({scope,items,value,onChange}:{scope:string;items:{id:T;label:string;icon:string;count?:number}[];value:T;onChange:(id:T)=>void}) {
  return <div className="a-desk-tabs" role="tablist" aria-label={`${scope} sections`}>
    {items.map(item=><button key={item.id} role="tab" id={`${scope}-tab-${item.id}`} aria-controls={`${scope}-panel-${item.id}`} aria-selected={value===item.id} tabIndex={value===item.id?0:-1} onClick={()=>onChange(item.id)} onKeyDown={e=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
      e.preventDefault();const i=items.findIndex(x=>x.id===item.id);
      const next=items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowRight'?1:-1)+items.length)%items.length];
      onChange(next.id);requestAnimationFrame(()=>document.getElementById(`${scope}-tab-${next.id}`)?.focus());
    }}><Icon name={item.icon} size={17}/><span>{item.label}</span>{item.count!==undefined&&<b>{item.count}</b>}</button>)}
  </div>;
}
export function AgentPanel({scope,id,active,children}:{scope:string;id:string;active:string;children:ReactNode}) {
  return <section className="a-desk-panel" id={`${scope}-panel-${id}`} role="tabpanel" aria-labelledby={`${scope}-tab-${id}`} hidden={active!==id}>{children}</section>;
}
export function DeskIntro({eyebrow,title,description,icon,children}:{eyebrow:string;title:string;description:string;icon:string;children?:ReactNode}) {
  return <header className="a-desk-intro"><span className="a-desk-intro-icon"><Icon name={icon} size={24}/></span><div><span className="a-overline">{eyebrow}</span><h3>{title}</h3><p>{description}</p></div>{children}</header>;
}
export function notificationPresentation(type:string) {
  const labels:Record<string,{title:string;icon:string;tone:string}>={
    representation_disputed:{title:'Relationship disputed',icon:'shield-check',tone:'urgent'},
    representation_confirmed:{title:'Representation confirmed',icon:'badge-check',tone:'positive'},
    representation_rejected:{title:'Request declined',icon:'user',tone:'quiet'},
    representation_expiring:{title:'Agreement approaching expiry',icon:'calendar-days',tone:'attention'},
    representation_terminated:{title:'Relationship ended',icon:'user',tone:'attention'},
    agency_membership:{title:'Agency membership update',icon:'users',tone:'quiet'},
    agent_verification:{title:'Credential update',icon:'badge-check',tone:'quiet'},
  };
  return labels[type]??{title:type.startsWith('regulatory_')?'Compliance update':type.startsWith('agent_transaction')?'Transaction update':'Portfolio update',icon:'bell',tone:'quiet'};
}
