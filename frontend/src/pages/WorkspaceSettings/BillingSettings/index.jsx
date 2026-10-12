import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import useUser from "@/hooks/useUser";
import System from "@/models/system";
import BillingAdminView from "./BillingAdminView";
import BillingCustomerView from "./BillingCustomerView";

/**
 * Billing Settings Tab
 *
 * Shows different views based on user role:
 * - Admin: Full write access to billing configuration
 * - Manager: Same view, but limit and billing cycle are read-only (KIE-533)
 * - Customer: Read-only view with usage stats and progress bar
 */
export default function BillingSettings({ workspace }) {
  const { t } = useTranslation();
  const { user } = useUser();
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchSettings() {
      const _settings = await System.keys();
      setSettings(_settings ?? {});
      setLoading(false);
    }
    fetchSettings();
  }, []);

  // Determine if user is a customer (default role in multi-user mode)
  // - Single-user mode: Always show admin view
  // - Multi-user mode with admin/manager: Show admin view
  // - Multi-user mode with default role: Show customer view (read-only)
  const isMultiUserMode = settings?.MultiUserMode === true;
  const isCustomer = isMultiUserMode && user?.role === "default";
  // KIE-533: Limit und Zyklus ändert nur admin. Für alle anderen verwirft der
  // Server die Felder (POST /workspace/:slug/update) - auch ohne
  // Mehrbenutzermodus, dort bleibt die API mit Schlüssel. Die Ansicht zeigt
  // die Werte dann gesperrt, statt ein Speichern vorzutäuschen.
  const canEditBilling = user?.role === "admin";

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-white/60">
          {t("Lade Abrechnungsdaten...")}
        </div>
      </div>
    );
  }

  if (!workspace) return null;

  // Show customer view for default users, admin view for everyone else
  return isCustomer ? (
    <BillingCustomerView workspace={workspace} />
  ) : (
    <BillingAdminView workspace={workspace} canEdit={canEditBilling} />
  );
}
