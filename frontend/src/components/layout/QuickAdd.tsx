import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';
import Modal from '../common/Modal';

const actions = [
  { label: 'Add Transaction', icon: '💳', path: '/accounts?add=transaction' },
  { label: 'Add Bank Account', icon: '🏦', path: '/accounts?add=bank' },
  { label: 'Add Credit Card', icon: '💳', path: '/accounts?add=credit-card' },
  { label: 'Add Investment', icon: '📈', path: '/investments?add=investment' },
  { label: 'Log Income', icon: '💰', path: '/income?add=income' },
  { label: 'Add Bill / Reminder', icon: '📋', path: '/?add=bill' },
  { label: 'Add Subscription', icon: '🔄', path: '/accounts?add=subscription' },
  { label: 'Add Goal', icon: '🎯', path: '/?add=goal' },
  { label: 'Log Super Contribution', icon: '🏦', path: '/investments?add=super' },
];

export default function QuickAdd() {
  const { quickAddOpen, setQuickAddOpen } = useStore();
  const navigate = useNavigate();

  const handleAction = (path: string) => {
    setQuickAddOpen(false);
    navigate(path);
  };

  return (
    <Modal isOpen={quickAddOpen} onClose={() => setQuickAddOpen(false)} title="Quick Add" size="sm">
      <div className="-mx-4 -my-2">
        {actions.map(action => (
          <button
            key={action.label}
            onClick={() => handleAction(action.path)}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-[8px] text-left
              hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors duration-150"
          >
            <span className="text-xl w-8 text-center" aria-hidden="true">{action.icon}</span>
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{action.label}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
