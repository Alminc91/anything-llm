import { useState } from "react";
import { useTranslation } from "react-i18next";

// We dont support all vectorDBs yet for reranking due to complexities of how each provider
// returns information. We need to normalize the response data so Reranker can be used for each provider.
const supportedVectorDBs = ["lancedb"];
const MODES = ["default", "rerank", "hybrid", "hybrid_rerank"];

export default function VectorSearchMode({ workspace, setHasChanges }) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState(
    workspace?.vectorSearchMode ?? "default"
  );
  if (!workspace?.vectorDB || !supportedVectorDBs.includes(workspace?.vectorDB))
    return null;

  return (
    <div>
      <div className="flex flex-col">
        <label htmlFor="name" className="block input-label">
          {t("vectorSearchMode.title")}
        </label>
      </div>
      <select
        name="vectorSearchMode"
        value={selection}
        className="border-none bg-theme-settings-input-bg text-white text-sm mt-2 rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5"
        onChange={(e) => {
          setSelection(e.target.value);
          setHasChanges(true);
        }}
        required={true}
      >
        {MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(`vectorSearchMode.${mode}.label`)}
          </option>
        ))}
      </select>
      <p className="text-white text-opacity-60 text-xs font-medium py-1.5">
        {t(`vectorSearchMode.${selection}.description`)}
      </p>
    </div>
  );
}
