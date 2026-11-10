/** Lesson sentences from ou-chinese-language (Kỹ năng đọc 1, B01-B02) and how they should split. */
export const SENTENCES: { text: string; words: string[]; lesson: string; todo?: string }[] = [
  { lesson: "B01", text: "我不是留学生，我是老师。", words: ["我", "不是", "留学生", "，", "我", "是", "老师", "。"] },
  { lesson: "B01", text: "很高兴认识你。", words: ["很", "高兴", "认识", "你", "。"] },
  // 张华 is in CC-CEDICT as a name.
  { lesson: "B01", text: "我姓张，叫张华。", words: ["我", "姓", "张", "，", "叫", "张华", "。"] },
  // Known gap: CC-CEDICT has 国人 (compatriot) and no 哪国, so longest match gives 哪|国人.
  // Fixing it needs word frequencies (plan 001, open question 1).
  { lesson: "B01", text: "大卫是哪国人？", words: ["大卫", "是", "哪", "国", "人", "？"], todo: "longest match splits 哪|国人; needs word frequencies" },
  { lesson: "B02", text: "他是职员，在银行工作。", words: ["他", "是", "职员", "，", "在", "银行", "工作", "。"] },
  { lesson: "B02", text: "他有一个七岁的儿子，是小学生。", words: ["他", "有", "一个", "七", "岁", "的", "儿子", "，", "是", "小学生", "。"] },
];
