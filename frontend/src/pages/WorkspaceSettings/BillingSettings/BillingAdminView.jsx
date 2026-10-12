import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import Workspace from "@/models/workspace";
import showToast from "@/utils/toast";
import { castToType } from "@/utils/types";
import { formatDateForInput } from "@/utils/billingDate";
import CTAButton from "@/components/lib/CTAButton";

/**
 * Admin View for Billing Settings
 * Allows admins to configure message limits and billing cycles
 * Also shows current usage statistics for support purposes
 *
 * KIE-533: Mit canEdit = false (Manager) sind Limit, Zyklusstart und -dauer
 * sichtbar, aber gesperrt; der Server verwirft diese Felder ohnehin.
 */
export default function BillingAdminView({ workspace, canEdit = true }) {
  const { t } = useTranslation();
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [usageData, setUsageData] = useState(null);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const formEl = useRef(null);

  // Fetch current usage data on mount
  useEffect(() => {
    async function loadInitialUsageData() {
      try {
        const data = await Workspace.getUsageInfo(workspace.slug);
        setUsageData(data);
      } catch (err) {
        console.error("Failed to fetch usage data:", err);
      }
      setLoadingUsage(false);
    }
    loadInitialUsageData();
  }, [workspace.slug]);

  // Reset-Tag aus den Serverwerten. Der Server liefert eine Tagesmarke
  // (00:00 UTC des Berliner Kalendertags), deshalb in UTC formatieren:
  // so stimmt der Tag unabhängig von der Zeitzone des Browsers.
  const formatResetDay = (dateValue) => {
    if (!dateValue) return null;
    const date = new Date(dateValue);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString("de-DE", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  };

  const [cycleStartDate, setCycleStartDate] = useState(
    formatDateForInput(workspace?.cycleStartDate)
  );
  const [cycleDurationMonths, setCycleDurationMonths] = useState(
    workspace?.cycleDurationMonths || ""
  );
  const [messagesLimit, setMessagesLimit] = useState(
    workspace?.messagesLimit ?? ""
  );

  // Das Abrechnungsfenster bestimmt allein der Server (getBillingWindow),
  // auch vor dem Zyklusstart: Bis dahin gilt der Kalendermonat, der spätestens
  // am Starttag endet. Solange ungespeicherte Änderungen bestehen, passt sein
  // Wert nicht zu den Eingaben; nach dem Speichern wird er neu geladen.
  const resetInfo = usageData?.resetInfo;

  // KIE-533: 0 heißt gesperrt (Limit erreicht), nur null heißt unbegrenzt.
  const usageLimit = usageData?.messagesLimit;
  const hasLimit = usageLimit !== null && usageLimit !== undefined;
  const usageRatio = !hasLimit
    ? 0
    : usageLimit > 0
      ? (usageData.messageCount ?? 0) / usageLimit
      : 1;
  const limitReached = hasLimit && usageRatio >= 1;

  const nextReset =
    hasChanges || !cycleStartDate
      ? null
      : formatResetDay(resetInfo?.nextReset);

  const cycleDurationOptions = [
    { value: 1, label: t("billing.cycle.1-month") },
    { value: 2, label: t("billing.cycle.2-months") },
    { value: 3, label: t("billing.cycle.3-months") },
    { value: 4, label: t("billing.cycle.4-months") },
    { value: 6, label: t("billing.cycle.6-months") },
    { value: 12, label: t("billing.cycle.12-months") },
  ];

  // Fetch usage data function (reusable)
  const fetchUsageData = async () => {
    try {
      const data = await Workspace.getUsageInfo(workspace.slug);
      setUsageData(data);
    } catch (err) {
      console.error("Failed to fetch usage data:", err);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    const data = {};
    const form = new FormData(formEl.current);
    for (var [key, value] of form.entries()) data[key] = castToType(key, value);

    const { workspace: updatedWorkspace, message } = await Workspace.update(
      workspace.slug,
      data
    );
    if (updatedWorkspace) {
      showToast(t("billing.admin.save-success"), "success", { clear: true });
      setHasChanges(false);
      // Reload usage data to reflect new limits
      await fetchUsageData();
    } else {
      showToast(t("billing.admin.save-error", { message }), "error", { clear: true });
    }
    setSaving(false);
  };

  return (
    <div id="workspace-billing-settings-container" className="relative">
      <form ref={formEl} onSubmit={handleUpdate} className="w-1/2 flex flex-col gap-y-6">
        {/* Save Button - top right like other tabs */}
        {canEdit && hasChanges && (
          <div className="absolute top-0 right-0">
            <CTAButton type="submit" disabled={saving}>
              {saving ? t("billing.admin.saving") : t("billing.admin.update-workspace")}
            </CTAButton>
          </div>
        )}

        {/* Current Usage Status - for admin to see customer's usage */}
        <div>
          <div className="flex flex-col gap-y-1">
            <label className="block text-sm font-medium text-white">
              {t("billing.admin.current-usage")}
            </label>
            <p className="text-white/60 text-xs">
              {t("billing.admin.usage-description")}
            </p>
          </div>

          {loadingUsage ? (
            <div className="animate-pulse text-white/60 text-sm mt-4">
              {t("billing.admin.loading-usage")}
            </div>
          ) : usageData ? (
            <div className="space-y-3 mt-4">
              {/* Usage Numbers */}
              <div className="flex items-end justify-between">
                <div>
                  <p className="text-white/60 text-sm">{t("billing.admin.consumed")}</p>
                  <p className="text-3xl font-bold text-white">
                    {usageData.messageCount?.toLocaleString("de-DE") ?? 0}
                    <span className="text-lg font-normal text-white/60">
                      {" / "}{usageData.messagesLimit?.toLocaleString("de-DE") ?? t("billing.admin.unlimited")}
                    </span>
                  </p>
                </div>
                {hasLimit && (
                  <div className="text-right">
                    <p className="text-white/60 text-sm">{t("billing.admin.remaining")}</p>
                    <p className="text-2xl font-semibold text-white">
                      {Math.max(0, usageData.messagesLimit - usageData.messageCount).toLocaleString("de-DE")}
                    </p>
                  </div>
                )}
              </div>

              {/* Progress Bar */}
              {hasLimit && (
                <div className="w-full bg-theme-settings-input-bg rounded-full h-4 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      usageRatio >= 1
                        ? "bg-red-500"
                        : usageRatio >= 0.8
                          ? "bg-yellow-500"
                          : "bg-green-500"
                    }`}
                    style={{ width: `${Math.min(usageRatio * 100, 100)}%` }}
                  />
                </div>
              )}

              {/* Percentage */}
              {hasLimit && (
                <div className="text-sm">
                  <span className={`font-medium ${
                    usageRatio >= 1
                      ? "text-red-400"
                      : usageRatio >= 0.8
                        ? "text-yellow-400"
                        : "text-white/60"
                  }`}>
                    {(usageRatio * 100).toFixed(1)}% {t("billing.admin.used")}
                  </span>
                  {limitReached && (
                    <span className="ml-2 font-semibold text-red-400">
                      {t("billing.admin.limit-reached")}
                    </span>
                  )}
                </div>
              )}

              {/* Manual API adjustments (deductions/credits) in current window */}
              {!!usageData.adjustmentsTotal && (
                <div className="text-sm">
                  <span className="text-white/60">
                    {t("billing.admin.api-adjustments")}:{" "}
                  </span>
                  <span className="text-white font-medium">
                    {usageData.adjustmentsTotal > 0 ? "+" : ""}
                    {usageData.adjustmentsTotal.toLocaleString("de-DE")}
                  </span>
                </div>
              )}

              {/* Reset of the current billing window (limited workspaces), plus cycle info while a cycle is running */}
              {!!resetInfo && (!!usageData.cycleInfo || usageData.messagesLimit != null) && (
                <div className="flex gap-x-8 pt-2">
                  <div>
                    <span className="text-white/60 text-xs block">{t("billing.admin.next-cycle-start")}</span>
                    <p className="text-white text-sm font-medium">
                      {formatResetDay(resetInfo.nextReset)}
                    </p>
                  </div>
                  <div>
                    <span className="text-white/60 text-xs block">{t("billing.admin.remaining")}</span>
                    <p className="text-white text-sm font-medium">
                      {resetInfo.daysRemaining} {resetInfo.daysRemaining === 1 ? t("billing.admin.day") : t("billing.admin.days")}
                    </p>
                  </div>
                  {usageData.cycleInfo && (
                    <>
                      <div>
                        <span className="text-white/60 text-xs block">{t("billing.admin.cycle-duration")}</span>
                        <p className="text-white text-sm font-medium">
                          {(() => {
                            const months = usageData.cycleInfo.cycleDurationMonths;
                            switch (months) {
                              case 1: return t("billing.cycle.1-month");
                              case 2: return t("billing.cycle.2-months");
                              case 3: return t("billing.cycle.3-months");
                              case 4: return t("billing.cycle.4-months");
                              case 6: return t("billing.cycle.6-months");
                              case 12: return t("billing.cycle.12-months");
                              default: return `${months} ${t("billing.cycle.months")}`;
                            }
                          })()}
                        </p>
                      </div>
                      <div>
                        <span className="text-white/60 text-xs block">{t("billing.admin.current-cycle")}</span>
                        <p className="text-white text-sm font-medium">
                          {usageData.cycleInfo.cycleNumber}
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="text-white/60 text-sm mt-4">
              {t("billing.admin.no-usage-data")}
            </div>
          )}
        </div>

        {/* Messages Limit Section */}
        <div>
          <div className="flex flex-col gap-y-1">
            <label htmlFor="messagesLimit" className="block text-sm font-medium text-white">
              {t("billing.admin.messages-limit")}
            </label>
            <p className="text-white/60 text-xs">
              {t("billing.admin.messages-limit-description")}
            </p>
          </div>
          <input
            name="messagesLimit"
            type="number"
            min={0}
            step={1}
            onWheel={(e) => e.target.blur()}
            value={messagesLimit}
            disabled={!canEdit}
            className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5 mt-4 disabled:opacity-60 disabled:cursor-not-allowed"
            placeholder={t("billing.admin.unlimited")}
            autoComplete="off"
            onChange={(e) => {
              setMessagesLimit(e.target.value);
              setHasChanges(true);
            }}
          />
        </div>

        {/* Billing Cycle Section */}
        <div>
          <div className="flex flex-col gap-y-1">
            <label className="block text-sm font-medium text-white">
              {t("billing.admin.billing-cycle")}
            </label>
            <p className="text-white/60 text-xs">
              {t("billing.admin.cycle-reset-description")}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            {/* Cycle Start Date */}
            <div>
              <label
                htmlFor="cycleStartDate"
                className="block mb-2 text-sm font-medium text-white"
              >
                {t("billing.admin.cycle-start-date")}
              </label>
              <input
                name="cycleStartDate"
                type="date"
                value={cycleStartDate}
                disabled={!canEdit}
                onChange={(e) => {
                  setCycleStartDate(e.target.value);
                  setHasChanges(true);
                }}
                className="border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
              />
            </div>

            {/* Cycle Duration */}
            <div>
              <label
                htmlFor="cycleDurationMonths"
                className="block mb-2 text-sm font-medium text-white"
              >
                {t("billing.admin.cycle-duration-label")}
              </label>
              <select
                name="cycleDurationMonths"
                value={cycleDurationMonths}
                disabled={!canEdit}
                onChange={(e) => {
                  setCycleDurationMonths(e.target.value ? parseInt(e.target.value) : "");
                  setHasChanges(true);
                }}
                className="border-none bg-theme-settings-input-bg text-white text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option value="">{t("billing.admin.select-placeholder")}</option>
                {cycleDurationOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Next Reset Info */}
          {nextReset && (
            <p className="text-sm text-white/60 mt-3">
              {t("billing.admin.next-cycle-start-label")}{" "}
              <span className="font-medium text-white">
                {nextReset}
              </span>
            </p>
          )}
        </div>

        {/* Info Box: Upgrade-Hinweis nur für den, der den Zyklus ändern darf */}
        <div className="p-4 bg-blue-500/15 rounded-lg border border-blue-500/30">
          <p className="text-sm text-blue-400">
            <strong>{t("billing.admin.info-title")}</strong>{" "}
            {canEdit
              ? t("billing.admin.info-text")
              : t("billing.admin.read-only-hint")}
          </p>
        </div>
      </form>
    </div>
  );
}
