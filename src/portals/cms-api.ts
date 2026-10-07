import { apiClient } from '../data/api';
import type { SitePage } from '../data/experience-api';
export type DraftSection = { id:string;component_code:string;title:string;payload:Record<string,unknown>;visible:boolean;position:number;variant:string;section_theme:string;style_overrides:Record<string,unknown>;responsive_config:Record<string,unknown> };
export type DraftPage = {permissions?:string[];id:string;title:string;path:string;description:string;draft_revision:number;status:string;sections:DraftSection[]};
export type Readiness = {revision:number;errors:string[];warnings:string[];diff:string[];ready:boolean};
export const cmsWorkspaceApi = {
  draft:(id:string)=>apiClient.get<DraftPage>(`/admin/cms/pages/${id}/draft`),
  save:(draft:DraftPage)=>apiClient.put<DraftPage>(`/admin/cms/pages/${draft.id}/draft`,{expectedRevision:draft.draft_revision,title:draft.title,path:draft.path,description:draft.description,sections:draft.sections.map(({id,component_code,title,payload,visible,position,variant,section_theme,style_overrides,responsive_config})=>({id,component_code,title,payload,visible,position,variant,section_theme,style_overrides,responsive_config}))}),
  readiness:(id:string)=>apiClient.get<Readiness>(`/admin/cms/pages/${id}/readiness`),
  duplicate:(id:string,title:string,path:string)=>apiClient.post<{id:string}>(`/admin/cms/pages/${id}/duplicate`,{title,path}),
  versionPreview:(id:string,version:number)=>apiClient.get<SitePage>(`/admin/cms/pages/${id}/versions/${version}/preview`),
  overview:()=>apiClient.get<{counts:{status:string;count:number}[];recent:{id:string;title:string;status:string;updated_at:string}[];upcoming:{title:string;starts_at:string}[]}>('/admin/cms/overview'),
};
export const PAGE_STATUS:Record<string,string>={draft:'پیش‌نویس',scheduled:'زمان‌بندی‌شده',published:'منتشرشده',archived:'بایگانی'};
export const PAGE_TYPE:Record<string,string>={home:'خانه',about:'درباره ما',landing:'لندینگ',campaign:'کمپین',collection:'کالکشن',vibe:'وایب',lead_generation:'جذب سرنخ',blog_index:'مجله',generic:'صفحه ساده'};
export const cmsError=(e:unknown)=>e instanceof Error?(/Failed to fetch|NetworkError|Load failed/i.test(e.message)?'ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید':e.message):'عملیات انجام نشد؛ دوباره تلاش کنید';
