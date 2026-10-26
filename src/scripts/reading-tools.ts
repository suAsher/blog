import { DEFAULT_READING_PREFERENCES, parseReadingPreferences, readingVariables, type ReadingPreferences } from '../lib/reading-preferences';
import { toast } from './shared';
import '../styles/reading-tools.css';

const storageKey = 'asher-reading-preferences-v1';
let preferences = { ...DEFAULT_READING_PREFERENCES };
try { preferences = parseReadingPreferences(localStorage.getItem(storageKey)); } catch { /* Bounded defaults remain available. */ }
function applyPreferences() {
  for (const [name,value] of Object.entries(readingVariables(preferences))) document.documentElement.style.setProperty(name,value);
  window.dispatchEvent(new Event('resize'));
}
applyPreferences();

function settingsDialog() {
  const dialog = document.createElement('dialog'); dialog.className = 'reading-settings'; dialog.id = 'reading-settings';
  dialog.setAttribute('aria-labelledby','reading-settings-title');
  const top = document.createElement('div'); top.className = 'reading-settings__heading';
  const heading = document.createElement('h2'); heading.id = 'reading-settings-title'; heading.textContent = '让阅读，更合你的习惯';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.textContent = '×'; close.setAttribute('aria-label','关闭阅读设置'); close.addEventListener('click',()=>dialog.close());
  top.append(heading,close); dialog.append(top);
  const groups: { key:keyof ReadingPreferences; title:string; choices:[number,string][] }[] = [
    {key:'fontSize',title:'正文字号',choices:[[17,'17 · 精细'],[19,'19 · 舒适'],[21,'21 · 宽松']]},
    {key:'width',title:'内容宽度',choices:[[680,'收拢'],[760,'标准'],[860,'展开']]},
    {key:'lineHeight',title:'文字行距',choices:[[1.8,'紧凑'],[2,'舒适'],[2.2,'舒展']]},
  ];
  function sync() { dialog.querySelectorAll<HTMLButtonElement>('[data-reading-choice]').forEach(button=>button.setAttribute('aria-pressed',String(preferences[button.dataset.key as keyof ReadingPreferences]===Number(button.dataset.value)))); }
  for (const group of groups) {
    const field=document.createElement('fieldset'); const legend=document.createElement('legend'); legend.textContent=group.title; field.append(legend);
    const row=document.createElement('div'); row.className='reading-settings__choices';
    for (const [value,label] of group.choices) {
      const button=document.createElement('button'); button.type='button'; button.textContent=label; button.dataset.readingChoice=''; button.dataset.key=group.key; button.dataset.value=String(value);
      button.addEventListener('click',()=>{preferences={...preferences,[group.key]:value};applyPreferences();sync();save();}); row.append(button);
    }
    field.append(row); dialog.append(field);
  }
  const footer=document.createElement('div'); footer.className='reading-settings__footer';
  const note=document.createElement('span'); note.textContent='偏好仅保存在此浏览器';
  const reset=document.createElement('button'); reset.type='button'; reset.textContent='恢复默认'; reset.className='quiet-link';
  function save() { try { localStorage.setItem(storageKey,JSON.stringify(preferences)); } catch { toast('阅读设置已生效，此浏览器未允许保存偏好。'); } }
  reset.addEventListener('click',()=>{preferences={...DEFAULT_READING_PREFERENCES};applyPreferences();sync();save();});
  footer.append(note,reset); dialog.append(footer); dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
  document.body.append(dialog); sync(); return dialog;
}

function initImageViewer(body: HTMLElement) {
  const images=[...body.querySelectorAll<HTMLImageElement>('img')].filter(image=>!image.closest('a,button,.interactive-block'));
  if(!images.length)return;
  const dialog=document.createElement('dialog'); dialog.className='image-viewer'; dialog.setAttribute('aria-label','文章图片预览');
  const close=document.createElement('button');close.type='button';close.className='image-viewer__close';close.textContent='关闭 ×';close.addEventListener('click',()=>dialog.close());
  const figure=document.createElement('figure');const enlarged=document.createElement('img');const caption=document.createElement('figcaption');figure.append(enlarged,caption);dialog.append(close,figure);document.body.append(dialog);
  dialog.addEventListener('click',event=>{if(event.target===dialog||event.target===figure)dialog.close();});
  dialog.addEventListener('close',()=>enlarged.removeAttribute('src'));
  for(const image of images){
    const button=document.createElement('button');button.type='button';button.className='image-open';button.setAttribute('aria-label',`放大图片：${image.alt||'文章配图'}`);button.setAttribute('aria-haspopup','dialog');image.before(button);button.append(image);
    button.addEventListener('click',()=>{if(!image.naturalWidth){toast('图片尚未加载完成，请稍后重试。');return;}enlarged.src=image.currentSrc||image.src;enlarged.alt=image.alt;caption.textContent=image.alt;dialog.showModal();});
  }
}

export function initReadingTools(body: HTMLElement) {
  if(body.dataset.readingTools==='true')return;body.dataset.readingTools='true';
  const toolbar=document.querySelector<HTMLElement>('.reader-toolbar');
  if(toolbar){
    const button=document.createElement('button');button.type='button';button.className='reader-tool reading-settings-trigger';button.setAttribute('aria-label','阅读设置');button.setAttribute('aria-haspopup','dialog');button.innerHTML='<span aria-hidden="true" class="reading-aa">Aa</span><span>阅读设置</span>';
    const dialog=settingsDialog();button.addEventListener('click',()=>dialog.showModal());toolbar.append(button);
  }
  initImageViewer(body);
}
