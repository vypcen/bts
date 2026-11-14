// CSV для Excel в русской локали: разделитель «;», ячейки, похожие на формулу, — с апострофом (защита от CSV-инъекций)
const FORMULA = /^[=+\-@\t\r]/;

const csvCell = (v) => {
  let s = String(v ?? "");
  if (FORMULA.test(s)) s = "'" + s;
  return /[;"\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(";") + "\r\n";

module.exports = { FORMULA, csvCell, csvRow };
