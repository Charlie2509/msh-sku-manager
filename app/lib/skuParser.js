import { macronReferenceMap } from "../data/macronReference";

const genders = ["SNR", "JNR"];
const colours = ["BLACK","WHITE","RED","GREEN","BLUE","NAVY","ROYAL","SKY","YELLOW","ORANGE","MAROON","PINK","PURPLE","GREY","GRAY"];
const types = ["JACKET","PADDED JACKET","WINTER THERMAL JACKET","TRAINING JACKET","RAIN JACKET","SHOWER JACKET","COAT","WINTER COAT","LONG COAT","BENCHCOAT","BENCH COAT","LONG BENCHCOAT","SHOWERJACKET","HOODY","HOODIE","HOODED TRACKSUIT TOP","GLOVES","CAP","BASEBALL CAP","TRUCKER CAP","HAT","BOBBLE HAT","WINTER BOBBLE HAT","BOBBLE","BUCKET HAT","SOCKS","MATCH SOCKS","SHORT SOCKS","TRAINING SOCKS","ANKLE SOCK","FIXED ANKLE SOCK","TARGET SOCK","SOCK","BACKPACK","RUCKSACK","TRAVEL RUCKSACK","HOLDALL","GYM KIT BAG","KIT BAG","SHOULDER BAG","BAG","POM","POM POM","NECKWARMER","BEANIE","POLO SHIRT","SHIRT","TEE","T-SHIRT","COTTON TEE","TRAINING TEE","TRAINING SWEATER","BODY WARMER","BODYWARMER","GILET","TRAINING SHORTS","TRAINING TOP","TRAINING PANTS","TRAINING BOTTOMS","SHORTS","TRACKSUIT","TRACKSUIT TOP","TRACKSUIT BOTTOMS","TRACKSUIT BOTTOM","TRACK PANTS","TROUSERS","PANTS","WATER BOTTLE","BOTTLE","1/4 ZIP TOP","FULL ZIP TOP","SWEATSHIRT","SWEATER","TOP","BOTTOMS"];
const modelStopWords = ["WINTER", "BOBBLE", "GAME", "DAY", "TARGET", "3D", "EMBROIDERED", "LONG"];
const removableWords = ["FC","AFC","UNITED","COACHES","PLAYERS","GIRLS","CONNECT","PIRATES","EASTBOURNE","HASTINGS","FOREST","ROW"];
const suspiciousModelWords = new Set(["3D"]);
const NEVER_A_MODEL_LOCAL = new Set([...removableWords,"HILLCREST","WESTHILL","BC","ABC","CLUB","GAME","DAY","WATER","BOTTLE"].map((w)=>w.toLowerCase()));

function isStrongModelWord(word){const t=word?.trim(); return Boolean(t && /[A-Z]/i.test(t) && /^[A-Z0-9-]+$/i.test(t));}
function toComparableToken(value){return value?.toUpperCase().replace(/[^A-Z0-9]/g,"") ?? "";}
const MULTI_WORD_COLOUR_PHRASES = ["ROYAL BLUE","LIGHT NAVY","DARK GREY","DARK GRAY","STONE GREY","STONE GRAY","GUN METAL","BOTTLE GREEN","NEON GREEN","NEON YELLOW","OFF WHITE","SKY BLUE","COLUMBIA"];
function tokeniseColour(value){
  if(!value) return [];
  return String(value).toUpperCase().trim().replace(/\s+/g," ").replace(/\//g," /").replace(/\s+\//g,"/").replace(/\/\s+/g,"/").split(/\s+|\//).filter(Boolean);
}
function normaliseColourTokens(tokens){
  if(!tokens.length) return [];
  const sortedPhrases=[...MULTI_WORD_COLOUR_PHRASES].sort((a,b)=>b.split(" ").length-a.split(" ").length);
  const parts=[];
  for(let i=0;i<tokens.length;i+=1){
    let matched=null;
    for(const phrase of sortedPhrases){
      const phraseTokens=phrase.split(" ");
      if(phraseTokens.every((t,idx)=>tokens[i+idx]===t)){ matched=phrase; break; }
    }
    if(matched){ parts.push(matched); i += matched.split(" ").length-1; continue; }
    parts.push(tokens[i]);
  }
  return parts;
}
export function normalizeColourDisplay(value){
  const tokens=tokeniseColour(value);
  if(!tokens.length) return null;
  const parts=normaliseColourTokens(tokens);
  return parts.join("/");
}
function toNormalisedColourSlug(value){
  const display=normalizeColourDisplay(value);
  return display?display.toLowerCase().replace(/\//g,"-").replace(/\s+/g,"-"):null;
}
export function normalizeAllowedColours(coloursList){
  if(!Array.isArray(coloursList)) return [];
  // Macron data can contain both space and slash versions of multi-tone colours; slash display is canonical.
  const bySlug=new Map();
  for(const colour of coloursList){
    const display=normalizeColourDisplay(colour);
    if(!display) continue;
    const slug=toNormalisedColourSlug(display);
    if(!slug) continue;
    const hasSlash=display.includes("/");
    const existing=bySlug.get(slug);
    if(!existing){ bySlug.set(slug,{display,hasSlash}); continue; }
    if(hasSlash&&!existing.hasSlash) bySlug.set(slug,{display,hasSlash});
  }
  return [...bySlug.values()].map((entry)=>entry.display);
}
export function detectColour(words, handle=""){const upper=words.map((w)=>toComparableToken(w)); const fromTitle=upper.find((w)=>colours.includes(w)); if(fromTitle) return fromTitle; const fromHandle=handle.split("-").map((p)=>toComparableToken(p)).filter(Boolean).find((p)=>colours.includes(p)); return fromHandle ?? null;}
function getModelReference(model){if(!model) return null; return macronReferenceMap[model.toLowerCase()] ?? null;}
function detectMacronModelFromTitle(words){if(!words?.length) return null; const lower=words.map((w)=>w.toLowerCase().replace(/[^a-z0-9]/g,"")); for(const span of [3,2,1]) for(let i=0;i<=lower.length-span;i+=1){const slice=lower.slice(i,i+span).filter(Boolean); if(!slice.length) continue; if(slice.every((t)=>NEVER_A_MODEL_LOCAL.has(t))) continue; if(span===1&&NEVER_A_MODEL_LOCAL.has(slice[0])) continue; for(const c of [slice.join("-"),slice.join(" "),slice.join("")]){const ref=macronReferenceMap[c]; if(ref) return {model: words.slice(i,i+span).join(" "), modelIndices:Array.from({length:span},(_,k)=>i+k), reference:ref};}} return null;}
export function detectColourFromVariant(variant, allowedColours){if(!variant?.selectedOptions) return null; const normalizedAllowed=normalizeAllowedColours(allowedColours ?? []); for(const opt of variant.selectedOptions){const n=(opt.name||"").toLowerCase(); if(n.includes("color")||n.includes("colour")){const normalizedVariant=normalizeColourDisplay(opt.value||""); if(!normalizedVariant) continue; if(normalizedAllowed.length){const m=normalizedAllowed.find((c)=>c===normalizedVariant||normalizedVariant.includes(c)||c.includes(normalizedVariant)); if(m) return m;} return normalizedVariant;}} return null;}
export function detectSizeFromVariant(variant){if(variant?.selectedOptions){for(const opt of variant.selectedOptions){if((opt.name||"").toLowerCase()==="size"&&opt.value) return opt.value;}} return variant?.title ?? null;}
function attachModelReference(parsed){if(!parsed.model) return parsed; const mr=getModelReference(parsed.model); const allowedColours=normalizeAllowedColours(mr?.allowedColours ?? []); return {...parsed, modelReference: mr, allowedColours: allowedColours.length?allowedColours:null};}
export function getAllowedColoursMessage(parsed){if(!parsed.modelReference) return "unknown"; const allowedColours=normalizeAllowedColours(parsed.allowedColours ?? []); if(!allowedColours.length) return "pending catalogue import"; return allowedColours.join(", ");}
function deriveParseMeta({model,type,colour}){const up=model?.toUpperCase()??null; const bad=up ? suspiciousModelWords.has(up):false; if(!model) return {status:"review", partialReason:"missing model"}; if(bad) return {status:"review", partialReason:"generic/review item"}; if(type&&colour) return {status:"matched", partialReason:null}; if(type&&!colour) return {status:"partial", partialReason:"missing colour"}; return {status:"partial", partialReason:null};}
function detectType(words){const upper=words.map((w)=>w.toUpperCase()); const sorted=[...types].sort((a,b)=>b.length-a.length); for(const candidateType of sorted){const tw=candidateType.split(/\s+/); for(let i=0;i<=upper.length-tw.length;i+=1){if(tw.every((t,o)=>upper[i+o]===t)){const idx=tw.map((_,o)=>i+o); return {type:candidateType,typeWords:tw,typeWordIndices:idx};}}} return {type:null,typeWords:[],typeWordIndices:[]};}
function parseFallbackProductTitle(words, handle="", typeInfo=null){const upper=words.map((w)=>toComparableToken(w)); const colour=detectColour(words,handle); const {type:detectedType,typeWords,typeWordIndices}=typeInfo??detectType(words); const idxSet=new Set(typeWordIndices); const hasBobbleAndSnow=upper.includes("BOBBLE")&&upper.includes("SNOW"); const removable=new Set([...removableWords,...genders,...(colour?[colour]:[]),...typeWords,...modelStopWords]); const model=words.find((w,i)=>{const u=w.toUpperCase(); if(idxSet.has(i)) return false; return isStrongModelWord(w)&&!removable.has(u);})??null; const preferred=hasBobbleAndSnow?words.find((w)=>w.toUpperCase()==="SNOW"):null; const resolvedModel=preferred??model; const resolvedType=detectedType ?? (upper.includes("BOBBLE")?"BOBBLE HAT":null); const meta=deriveParseMeta({model:resolvedModel,type:resolvedType,colour}); return attachModelReference({club:null,model:resolvedModel,type:resolvedType,colour,status:meta.status,partialReason:meta.partialReason});}
export function parseProductTitle(title, handle=""){const words=title.split(/\s+/).filter(Boolean); const upper=words.map((w)=>w.toUpperCase()); const genderIndex=upper.findIndex((w)=>genders.includes(w)); const modelIndex=genderIndex!==-1?genderIndex+1:-1; const typeInfo=detectType(words); const typeSet=new Set(typeInfo.typeWordIndices); const clubWords=genderIndex>0?words.slice(0,genderIndex):[]; const club=clubWords.length?clubWords.join(" "):null; const macronHit=detectMacronModelFromTitle(words); const direct=modelIndex!==-1&&modelIndex<words.length?words[modelIndex]:null; const directUpper=direct?.toUpperCase()??null; const directOk=direct&&isStrongModelWord(direct)&&!typeSet.has(modelIndex)&&directUpper&&!modelStopWords.includes(directUpper); const model=macronHit?.model ?? (directOk?direct:null); const wordsAfter=modelIndex!==-1&&modelIndex+1<words.length?upper.slice(modelIndex+1):[]; const typeSegment=wordsAfter.join(" ").trim(); const sorted=[...types].sort((a,b)=>b.length-a.length); const detectedType=typeInfo.type ?? sorted.find((t)=>typeSegment.includes(t)); const detectedColour=detectColour(words,handle); const type=detectedType ?? (typeSegment||null); const colour=detectedColour ?? null; const meta=deriveParseMeta({model,type,colour}); if(model) return attachModelReference({club,model,type,colour,status:meta.status,partialReason:meta.partialReason}); return parseFallbackProductTitle(words,handle,typeInfo);}
