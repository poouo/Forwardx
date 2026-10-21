export type TableColumn<Id extends string = string> = {
  id: Id;
  label: string;
  width: number;
  min: number;
  max: number;
  required?: boolean;
  adminOnly?: boolean;
};

export type TableLayout<Id extends string = string> = {
  order: Id[];
  hidden: Id[];
  widths: Partial<Record<Id, number>>;
};
