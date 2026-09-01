import Layout from '../components/layout/Layout';
import { PageHeader } from '../components/design-kit/UI';
import SharingSection from '../components/settings/SharingSection';

/**
 * Households — its own place, not a section inside Settings.
 *
 * Sharing your finances with another person is a job you come here to do, and
 * one with consequences (who sees what, whose rows count once): it is not a
 * preference you flip on the way past. Settings keeps profile, appearance and
 * the account itself; this is a destination of its own, on the bar and on the
 * More grid, and /settings?section=households still lands here.
 */
export default function Households() {
  return (
    <Layout>
      <PageHeader
        title="Households"
        subtitle="Who you share with, and what they can see"
      />
      <SharingSection />
    </Layout>
  );
}
