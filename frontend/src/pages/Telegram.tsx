import Layout from '../components/layout/Layout';
import { PageHeader } from '../components/design-kit/UI';
import TelegramSection from '../components/settings/TelegramSection';

/**
 * Telegram — your bot, and the briefing it sends.
 */
export default function Telegram() {
  return (
    <Layout>
      <PageHeader
        title="Telegram"
        subtitle="Your bot, the connection it runs on, and the briefing it sends"
      />
      <TelegramSection />
    </Layout>
  );
}
