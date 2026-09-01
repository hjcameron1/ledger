import Layout from '../components/layout/Layout';
import { PageHeader } from '../components/design-kit/UI';
import BillingSection from '../components/settings/BillingSection';

/**
 * Plan & Billing — what you are on, what it includes, and how to change it.
 */
export default function Billing() {
  return (
    <Layout>
      <PageHeader title="Plan & Billing" subtitle="Your plan and what it includes" />
      <BillingSection />
    </Layout>
  );
}
