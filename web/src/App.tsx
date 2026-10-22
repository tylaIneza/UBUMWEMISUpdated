import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './Layout';
import { AuditLogs, Settings, Users } from './pages/admin';
import { Account, ForgotPassword, ResetPassword, VerifyEmail } from './pages/auth';
import { Login } from './pages/Login';
import { ContractDetail, Contracts } from './pages/contracts';
import { DailyOperations, Dashboard } from './pages/dashboard';
import { Approvals, Expenses, Maintenance, Notifications } from './pages/operations';
import { Deposits, Invoices, PaymentDetail, Payments, RecordPayment, Rent } from './pages/payments';
import { Buildings, Floors, RoomDetail, Rooms } from './pages/property';
import { Reminders } from './pages/reminders';
import { Reports } from './pages/reports';
import { Onboarding, RegisterTenant, TenantDetail, Tenants } from './pages/tenants';
import { Empty, Loading } from './ui';

/** Hides a screen the user's role cannot use. The server enforces the same rule on every request regardless. */
function Guard({ perm, children }: { perm: string[]; children: React.ReactNode }) {
  const { can } = useAuth();
  if (perm.length && !can(...perm)) return <Empty title="You do not have access to this page">Ask an administrator if you need it.</Empty>;
  return <>{children}</>;
}

function Private() {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading what="Loading" />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Layout />;
}

const page = (perm: string[], el: React.ReactNode) => <Guard perm={perm}>{el}</Guard>;

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route element={<Private />}>
        <Route path="/" element={page(['dashboard.view'], <Dashboard />)} />
        <Route path="/daily" element={page(['dashboard.view'], <DailyOperations />)} />
        <Route path="/buildings" element={page(['building.view'], <Buildings />)} />
        <Route path="/floors" element={page(['building.view'], <Floors />)} />
        <Route path="/rooms" element={page(['room.view'], <Rooms />)} />
        <Route path="/rooms/:id" element={page(['room.view'], <RoomDetail />)} />
        <Route path="/tenants" element={page(['tenant.view'], <Tenants />)} />
        <Route path="/tenants/new" element={page(['tenant.manage'], <RegisterTenant />)} />
        <Route path="/tenants/:id" element={page(['tenant.view'], <TenantDetail />)} />
        <Route path="/contracts" element={page(['contract.view'], <Contracts />)} />
        <Route path="/contracts/new" element={page(['contract.manage'], <Onboarding existing />)} />
        <Route path="/contracts/:id" element={page(['contract.view'], <ContractDetail />)} />
        <Route path="/rent" element={page(['rent.view'], <Rent />)} />
        <Route path="/unpaid" element={page(['rent.view'], <Rent owing />)} />
        <Route path="/payments" element={page(['payment.view'], <Payments />)} />
        <Route path="/payments/new" element={page(['payment.create'], <RecordPayment />)} />
        <Route path="/payments/:id" element={page(['payment.view'], <PaymentDetail />)} />
        <Route path="/invoices" element={page(['invoice.view'], <Invoices />)} />
        <Route path="/deposits" element={page(['deposit.view'], <Deposits />)} />
        <Route path="/expenses" element={page(['expense.view'], <Expenses />)} />
        <Route path="/maintenance" element={page(['maintenance.view'], <Maintenance />)} />
        <Route path="/reminders" element={page(['message.create'], <Reminders />)} />
        <Route path="/approvals" element={page(['approval.view', 'approval.decide'], <Approvals />)} />
        <Route path="/reports" element={page(['report.view', 'report.financial'], <Reports />)} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/users" element={page(['user.manage'], <Users />)} />
        <Route path="/settings" element={page(['settings.manage', 'period.manage', 'import.data'], <Settings />)} />
        <Route path="/audit" element={page(['audit.view'], <AuditLogs />)} />
        <Route path="/account" element={<Account />} />
        <Route path="*" element={<Empty title="Page not found">The address does not match any screen.</Empty>} />
      </Route>
    </Routes>
  );
}
