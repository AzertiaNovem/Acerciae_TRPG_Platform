import { t } from '../i18n';

type PageCitation = { page: number; excerpt?: string | null };
export default function PageCitations({ citations, maxExcerpt, onPage }: {
  citations?: PageCitation[] | null;
  maxExcerpt: number;
  onPage?: (page: number) => void;
}) {
  return <>{(Array.isArray(citations) ? citations : []).filter(c => c && Number.isInteger(c.page) && c.page > 0).slice(0, 2).map((c, i) => {
    const excerpt = typeof c.excerpt === 'string' ? c.excerpt.slice(0, maxExcerpt) : '';
    const label = <>{t('p.')}{c.page}{excerpt && <>: “{excerpt}”</>}</>;
    return <div key={i} className="cit">{onPage ? <button className="ghost small" onClick={() => onPage(c.page)}>{label}</button> : label}</div>;
  })}</>;
}
