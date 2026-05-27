import { useNavigate } from 'react-router-dom';
import { useStore } from '../../store';

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

  if (!quickAddOpen) return null;

  const handleAction = (path: string) => {
    setQuickAddOpen(false);
    navigate(path);
  };

  return (
    <div className="modal-backdrop flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setQuickAddOpen(false)}>
      <div
        className="modal-panel relative w-full max-w-sm bg-white dark:bg-[#1a1a1a]
          rounded-t-[20px] sm:rounded-[16px] shadow-2xl z-50 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
          <h2 className="text-lg font-semibold">Quick Add</h2>
          <button
            onClick={() => setQuickAddOpen(false)}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a]"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="p-2">
          {actions.map(action => (
            <button
              key={action.label}
              onClick={() => handleAction(action.path)}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-[8px] text-left
                hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] transition-colors duration-150"
            >
              <span className="text-xl w-8 text-center">{action.icon}</span>
              <span className="text-sm font-medium text-[#0f0f0f] dark:text-[#f5f5f5]">{action.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
