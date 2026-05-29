export declare const DEFAULT_DATE_FORMAT = "YYYY-MM-DD HH:mm:ss";
export type DateFormatPreset = {
    value: string;
    label: string;
    /** 该格式是否包含时分秒；用于决定单元格 editor / 表单 input 类型。 */
    hasTime: boolean;
};
export declare const DATE_FORMAT_PRESETS: DateFormatPreset[];
/** 判断格式串里是否含有时间部分。 */
export declare function dateFormatHasTime(format: string | undefined | null): boolean;
export declare function resolveDateFormat(format: string | undefined | null): string;
/** 把任意日期值转成 Date；解析失败返回 null。 */
export declare function toDate(value: unknown): Date | null;
/** 把日期值按格式渲染；空/无效返回 ""。 */
export declare function formatDateValue(value: unknown, format: string | undefined | null): string;
/**
 * 将 `<input type="datetime-local">` / `<input type="date">` 的值
 * 转回 Date（本地时区）。空字符串返回 null。
 */
export declare function parseDateInput(raw: string, hasTime: boolean): Date | null;
/**
 * 把日期值转成 `<input type="datetime-local">` 期待的字符串
 * （本地时区，"YYYY-MM-DDTHH:mm"）。空值返回 ""。
 */
export declare function toDateTimeLocalValue(value: unknown): string;
/** 把日期值转成 `<input type="date">` 期待的字符串（本地时区，"YYYY-MM-DD"）。空值返回 ""。 */
export declare function toDateInputValue(value: unknown): string;
/**
 * 校验自定义格式串是否合法。dayjs 不会因为格式串错误抛错，
 * 只能通过 format 后再 parse 回来比对。
 */
export declare function isValidDateFormat(format: string): boolean;
