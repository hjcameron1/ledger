import Layout from '../components/layout/Layout';
import { PageHeader } from '../components/design-kit/UI';
import CategoriesSection from '../components/settings/CategoriesSection';

/**
 * Categories — the labels your spending is filed under.
 */
export default function Categories() {
  return (
    <Layout>
      <PageHeader
        title="Categories"
        subtitle="The labels every transaction, budget and rule resolves into"
      />
      <CategoriesSection />
    </Layout>
  );
}
