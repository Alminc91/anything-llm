import React, { useEffect, useState } from "react";
import Sidebar from "@/components/SettingsSidebar";
import { isMobile } from "react-device-detect";
import PreLoader from "@/components/Preloader";
import CTAButton from "@/components/lib/CTAButton";
import Admin from "@/models/admin";
import System from "@/models/system";
import showToast from "@/utils/toast";
import { useTranslation } from "react-i18next";
import { CaretDown, CaretRight } from "@phosphor-icons/react";

const SYSTEM_PREF_FIELDS = [
  "query_rewrite_default",
  "vector_search_default",
  "hybrid_weight",
  "reranker_instruction",
  "reranker_retrieval_topk",
  "metadata_filters",
  "metadata_filter_locations",
  "search_trace",
];

export default function SearchRetrievalPreference() {
  const [settings, setSettings] = useState({});
  const [envKeys, setEnvKeys] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { t } = useTranslation();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const form = new FormData(e.target);

      // SystemSettings rows (persisted in DB) — no migration required.
      // The advanced inputs only exist in the DOM while the panel is expanded;
      // form.get() returns null for unmounted fields and sending null would
      // reset their stored values to the server defaults.
      const prefsUpdate = {
        query_rewrite_default: form.get("query_rewrite_default"),
        vector_search_default: form.get("vector_search_default"),
        reranker_retrieval_topk: form.get("reranker_retrieval_topk"),
        metadata_filters: form.get("metadata_filters"),
        metadata_filter_locations: form.get("metadata_filter_locations"),
      };
      const hybridWeight = form.get("hybrid_weight");
      if (hybridWeight !== null) prefsUpdate.hybrid_weight = hybridWeight;
      const rerankerInstruction = form.get("reranker_instruction");
      if (rerankerInstruction !== null)
        prefsUpdate.reranker_instruction = rerankerInstruction;
      const searchTrace = form.get("search_trace");
      if (searchTrace !== null) prefsUpdate.search_trace = searchTrace;
      await Admin.updateSystemPreferences(prefsUpdate);

      // ENV keys (persisted via dumpENV through KEY_MAPPING). The provider
      // select uses "" to mean "native" (unset RERANKER_PROVIDER).
      const envUpdate = {
        RerankerProvider: form.get("RerankerProvider") || "",
        RerankerBasePath: form.get("RerankerBasePath") || "",
        RerankerModelPref: form.get("RerankerModelPref") || "",
      };
      // Timeout lives in the collapsed advanced panel — same unmounted-field
      // rule as the system preferences above (blank clears back to default).
      const timeoutMs = form.get("RerankerTimeoutMs");
      if (timeoutMs !== null) envUpdate.RerankerTimeoutMs = timeoutMs;
      // Only send the API key when the admin actually typed a new value so we
      // never clobber an existing key with the masked placeholder.
      const apiKey = form.get("RerankerApiKey");
      if (apiKey && apiKey.length > 0) envUpdate.RerankerApiKey = apiKey;

      const { error } = await System.updateSystem(envUpdate);
      if (error) throw new Error(error);

      setHasChanges(false);
      showToast(t("common.save-success"), "success");
    } catch (e) {
      console.error(e);
      showToast(t("common.save-error"), "error");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    async function fetchSettings() {
      const _settings = (
        await Admin.systemPreferencesByFields(SYSTEM_PREF_FIELDS)
      )?.settings;
      const _keys = (await System.keys()) || {};
      setSettings(_settings ?? {});
      setEnvKeys(_keys);
      setLoading(false);
    }
    fetchSettings();
  }, []);

  if (loading) {
    return (
      <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
        <Sidebar />
        <div
          style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
          className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
        >
          <div className="w-full h-full flex justify-center items-center">
            <PreLoader />
          </div>
        </div>
      </div>
    );
  }

  const inputClass =
    "border-none bg-theme-settings-input-bg text-white text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5 placeholder:text-theme-settings-input-placeholder";

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <form
          onSubmit={handleSubmit}
          onChange={() => setHasChanges(true)}
          className="flex w-full"
        >
          <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:py-6 py-16">
            <div className="w-full flex flex-col gap-y-1 pb-4 border-white light:border-theme-sidebar-border border-b-2 border-opacity-10">
              <div className="flex gap-x-4 items-center">
                <p className="text-lg leading-6 font-bold text-white">
                  {t("searchRetrieval.title")}
                </p>
              </div>
              <p className="text-xs leading-[18px] font-base text-white text-opacity-60">
                {t("searchRetrieval.description")}
              </p>
            </div>
            <div className="w-full justify-end flex">
              {hasChanges && (
                <CTAButton className="mt-3 mr-0 -mb-14 z-10">
                  {saving ? t("common.saving") : t("common.save")}
                </CTAButton>
              )}
            </div>

            <div className="flex flex-col gap-y-4 mt-8">
              {/* Query Rewriting */}
              <div className="flex flex-col max-w-[500px]">
                <div className="flex flex-col gap-y-2 mb-4">
                  <label className="text-white text-sm font-semibold block">
                    {t("searchRetrieval.queryRewrite.title")}
                  </label>
                  <p className="text-xs text-white/60">
                    {t("searchRetrieval.queryRewrite.description")}
                  </p>
                </div>
                <select
                  name="query_rewrite_default"
                  defaultValue={settings?.query_rewrite_default ?? "off"}
                  className={inputClass}
                >
                  <option value="on">
                    {t("searchRetrieval.queryRewrite.on")}
                  </option>
                  <option value="off">
                    {t("searchRetrieval.queryRewrite.off")}
                  </option>
                </select>
              </div>

              {/* Hybrid Search & Reranking */}
              <div className="flex flex-col gap-y-1 mt-6 pb-2 border-white light:border-theme-sidebar-border border-b-2 border-opacity-10 max-w-[500px]">
                <p className="text-sm leading-6 font-bold text-white">
                  {t("searchRetrieval.hybrid.title")}
                </p>
                <p className="text-xs leading-[18px] font-base text-white text-opacity-60">
                  {t("searchRetrieval.hybrid.description")}
                </p>
              </div>

              {/* Default Search Mode */}
              <div className="flex flex-col max-w-[500px]">
                <div className="flex flex-col gap-y-2 mb-4">
                  <label className="text-white text-sm font-semibold block">
                    {t("searchRetrieval.hybrid.mode.title")}
                  </label>
                  <p className="text-xs text-white/60">
                    {t("searchRetrieval.hybrid.mode.description")}
                  </p>
                </div>
                <select
                  name="vector_search_default"
                  defaultValue={settings?.vector_search_default ?? "default"}
                  className={inputClass}
                >
                  <option value="default">
                    {t("searchRetrieval.hybrid.mode.default")}
                  </option>
                  <option value="rerank">
                    {t("searchRetrieval.hybrid.mode.rerank")}
                  </option>
                  <option value="hybrid">
                    {t("searchRetrieval.hybrid.mode.hybrid")}
                  </option>
                  <option value="hybrid_rerank">
                    {t("searchRetrieval.hybrid.mode.hybrid_rerank")}
                  </option>
                </select>
              </div>

              {/* Reranker Provider */}
              <div className="flex flex-col max-w-[500px]">
                <div className="flex flex-col gap-y-2 mb-4">
                  <label className="text-white text-sm font-semibold block">
                    {t("searchRetrieval.hybrid.provider.title")}
                  </label>
                  <p className="text-xs text-white/60">
                    {t("searchRetrieval.hybrid.provider.description")}
                  </p>
                </div>
                <select
                  name="RerankerProvider"
                  defaultValue={envKeys?.RerankerProvider ?? ""}
                  className={inputClass}
                >
                  <option value="">
                    {t("searchRetrieval.hybrid.provider.native")}
                  </option>
                  <option value="cohere">
                    {t("searchRetrieval.hybrid.provider.cohere")}
                  </option>
                  <option value="tei">
                    {t("searchRetrieval.hybrid.provider.tei")}
                  </option>
                </select>
              </div>

              {/* Reranker Base URL */}
              <div className="flex flex-col max-w-[500px]">
                <div className="flex flex-col gap-y-2 mb-4">
                  <label className="text-white text-sm font-semibold block">
                    {t("searchRetrieval.hybrid.basePath.title")}
                  </label>
                  <p className="text-xs text-white/60">
                    {t("searchRetrieval.hybrid.basePath.description")}
                  </p>
                </div>
                <input
                  type="url"
                  name="RerankerBasePath"
                  defaultValue={envKeys?.RerankerBasePath ?? ""}
                  placeholder="http://localhost:8080"
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </div>

              {/* Reranker Model */}
              <div className="flex flex-col max-w-[500px]">
                <div className="flex flex-col gap-y-2 mb-4">
                  <label className="text-white text-sm font-semibold block">
                    {t("searchRetrieval.hybrid.model.title")}
                  </label>
                  <p className="text-xs text-white/60">
                    {t("searchRetrieval.hybrid.model.description")}
                  </p>
                </div>
                <input
                  type="text"
                  name="RerankerModelPref"
                  defaultValue={envKeys?.RerankerModelPref ?? ""}
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </div>

              {/* Retrieval Candidates */}
              <div className="flex flex-col max-w-[500px]">
                <div className="flex flex-col gap-y-2 mb-4">
                  <label className="text-white text-sm font-semibold block">
                    {t("searchRetrieval.hybrid.candidates.title")}
                  </label>
                  <p className="text-xs text-white/60">
                    {t("searchRetrieval.hybrid.candidates.description")}
                  </p>
                </div>
                <input
                  type="number"
                  name="reranker_retrieval_topk"
                  min={1}
                  max={500}
                  step={1}
                  defaultValue={settings?.reranker_retrieval_topk ?? 40}
                  className={inputClass}
                />
              </div>

              {/* Metadaten-Filter (KIE-480) */}
              <div className="flex flex-col gap-y-1 mt-6 pb-2 border-white light:border-theme-sidebar-border border-b-2 border-opacity-10 max-w-[500px]">
                <p className="text-sm leading-6 font-bold text-white">
                  {t("searchRetrieval.metadataFilters.title")}
                </p>
                <p className="text-xs leading-[18px] font-base text-white text-opacity-60">
                  {t("searchRetrieval.metadataFilters.description")}
                </p>
              </div>

              <div className="flex flex-col max-w-[500px]">
                <select
                  name="metadata_filters"
                  defaultValue={settings?.metadata_filters ?? "off"}
                  className={inputClass}
                >
                  <option value="off">
                    {t("searchRetrieval.metadataFilters.off")}
                  </option>
                  <option value="on">
                    {t("searchRetrieval.metadataFilters.on")}
                  </option>
                </select>
              </div>

              {/* Standort-Whitelist */}
              <div className="flex flex-col max-w-[500px]">
                <div className="flex flex-col gap-y-2 mb-4">
                  <label className="text-white text-sm font-semibold block">
                    {t("searchRetrieval.metadataFilters.locations.title")}
                  </label>
                  <p className="text-xs text-white/60">
                    {t("searchRetrieval.metadataFilters.locations.description")}
                  </p>
                </div>
                <input
                  type="text"
                  name="metadata_filter_locations"
                  defaultValue={settings?.metadata_filter_locations ?? ""}
                  placeholder={t(
                    "searchRetrieval.metadataFilters.locations.placeholder"
                  )}
                  autoComplete="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </div>

              {/* Advanced (collapsed) */}
              <div className="flex flex-col max-w-[500px] mt-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex items-center gap-x-2 text-white text-sm font-semibold hover:text-white/80 transition-colors"
                >
                  {showAdvanced ? (
                    <CaretDown size={16} weight="bold" />
                  ) : (
                    <CaretRight size={16} weight="bold" />
                  )}
                  {t("searchRetrieval.hybrid.advanced")}
                </button>
              </div>

              {showAdvanced && (
                <div className="flex flex-col gap-y-4">
                  {/* Hybrid Weight (alpha) */}
                  <div className="flex flex-col max-w-[500px]">
                    <div className="flex flex-col gap-y-2 mb-4">
                      <label className="text-white text-sm font-semibold block">
                        {t("searchRetrieval.hybrid.weight.title")}
                      </label>
                      <p className="text-xs text-white/60">
                        {t("searchRetrieval.hybrid.weight.description")}
                      </p>
                    </div>
                    <input
                      type="number"
                      name="hybrid_weight"
                      min={0}
                      max={1}
                      step={0.05}
                      defaultValue={settings?.hybrid_weight ?? 0.7}
                      className={inputClass}
                    />
                  </div>

                  {/* Reranker Instruction */}
                  <div className="flex flex-col max-w-[500px]">
                    <div className="flex flex-col gap-y-2 mb-4">
                      <label className="text-white text-sm font-semibold block">
                        {t("searchRetrieval.hybrid.instruction.title")}
                      </label>
                      <p className="text-xs text-white/60">
                        {t("searchRetrieval.hybrid.instruction.description")}
                      </p>
                    </div>
                    <input
                      type="text"
                      name="reranker_instruction"
                      defaultValue={settings?.reranker_instruction ?? ""}
                      placeholder={t(
                        "searchRetrieval.hybrid.instruction.placeholder"
                      )}
                      autoComplete="off"
                      className={inputClass}
                    />
                  </div>

                  {/* Search-Trace (Diagnostik) */}
                  <div className="flex flex-col max-w-[500px]">
                    <div className="flex flex-col gap-y-2 mb-4">
                      <label className="text-white text-sm font-semibold block">
                        {t("searchRetrieval.trace.title")}
                      </label>
                      <p className="text-xs text-white/60">
                        {t("searchRetrieval.trace.description")}
                      </p>
                    </div>
                    <select
                      name="search_trace"
                      defaultValue={settings?.search_trace ?? "off"}
                      className={inputClass}
                    >
                      <option value="off">
                        {t("searchRetrieval.trace.off")}
                      </option>
                      <option value="on">{t("searchRetrieval.trace.on")}</option>
                      <option value="full">
                        {t("searchRetrieval.trace.full")}
                      </option>
                    </select>
                  </div>

                  {/* Reranker Timeout */}
                  <div className="flex flex-col max-w-[500px]">
                    <div className="flex flex-col gap-y-2 mb-4">
                      <label className="text-white text-sm font-semibold block">
                        {t("searchRetrieval.hybrid.timeout.title")}
                      </label>
                      <p className="text-xs text-white/60">
                        {t("searchRetrieval.hybrid.timeout.description")}
                      </p>
                    </div>
                    <input
                      type="number"
                      name="RerankerTimeoutMs"
                      min={500}
                      max={60000}
                      step={500}
                      defaultValue={envKeys?.RerankerTimeoutMs ?? 8000}
                      className={inputClass}
                    />
                  </div>

                  {/* Reranker API Key */}
                  <div className="flex flex-col max-w-[500px]">
                    <div className="flex flex-col gap-y-2 mb-4">
                      <label className="text-white text-sm font-semibold block">
                        {t("searchRetrieval.hybrid.apiKey.title")}
                      </label>
                      <p className="text-xs text-white/60">
                        {t("searchRetrieval.hybrid.apiKey.description")}
                      </p>
                    </div>
                    <input
                      type="password"
                      name="RerankerApiKey"
                      defaultValue=""
                      placeholder={
                        envKeys?.RerankerApiKey
                          ? "••••••••••••••••"
                          : t("searchRetrieval.hybrid.apiKey.placeholder")
                      }
                      autoComplete="off"
                      spellCheck={false}
                      className={inputClass}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
