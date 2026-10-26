const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

export const textFields = {
  title: element<HTMLInputElement>("document-title"),
  description: element<HTMLTextAreaElement>("document-description"),
  tags: element<HTMLInputElement>("document-tags"),
  category: element<HTMLInputElement>("document-category"),
  date: element<HTMLInputElement>("document-date"),
  cover: element<HTMLInputElement>("document-cover"),
  series: element<HTMLInputElement>("document-series"),
  source: element<HTMLTextAreaElement>("document-source"),
};

export const selectFields = {
  kind: element<HTMLSelectElement>("document-kind"),
  maturity: element<HTMLSelectElement>("document-maturity"),
};

export const fields = { ...textFields, ...selectFields };

export const relatedFields = {
  search: element<HTMLInputElement>("document-related-search"),
  suggestions: element<HTMLElement>("related-suggestions"),
  chips: element<HTMLElement>("related-chips"),
};

export function setEditorFieldsLocked(locked: boolean): void {
  Object.values(textFields).forEach((field) => {
    field.readOnly = locked;
  });
  Object.values(selectFields).forEach((field) => {
    field.disabled = locked;
  });
}
