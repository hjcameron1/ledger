import { Link } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import NavIcon from '../components/layout/NavIcon';
import { moreSections, type Destination } from '../utils/appearance';
import { PageHeader } from '../components/design-kit/UI';

/**
 * "More" — everything the peaceful view keeps off the tab bar.
 *
 * The peaceful bar carries three places and this page. That only works if this
 * page is genuinely everything else, so it is built from the SAME destination
 * list the nav is (utils/appearance) rather than a hand-kept second list: a page
 * added to Ledger appears here without anyone remembering to add it, which is
 * the only way "four tabs" can be a simplification rather than a hiding place.
 *
 * Reachable in both views — the technical strip just doesn't need it.
 */

function Tile({ d }: { d: Destination }) {
  return (
    <Link
      to={d.to}
      className="card p-4 flex flex-col gap-3 transition-transform duration-150 active:scale-[0.98] hover:border-zinc-300 dark:hover:border-zinc-700"
    >
      <span className={`w-10 h-10 rounded-[12px] flex items-center justify-center ${d.tint}`}>
        <NavIcon name={d.icon} size={20} />
      </span>
      <span>
        <span className="block font-semibold leading-tight">{d.label}</span>
        <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-snug">{d.blurb}</span>
      </span>
    </Link>
  );
}

export default function More() {
  const sections = moreSections();

  return (
    <Layout>
      <PageHeader title="More" subtitle="Everything else in Ledger" />

      <div className="space-y-7">
        {sections.map(({ group, items }) => (
          <section key={group}>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500 mb-2.5">
              {group}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {items.map(d => <Tile key={d.to} d={d} />)}
            </div>
          </section>
        ))}
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-8">
        Prefer every page on the bar instead? Settings → Appearance → View.
      </p>
    </Layout>
  );
}
