import ast
from typing import Any, Callable, Dict, List

from .common import as_text, format_number, parse_number


def to_number(value: Any, field_name: str) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return parse_number(value, field_name)


def expression_values(rows: List[Dict[str, str]], field_name: str) -> List[str]:
    normalized_field = as_text(field_name)
    if not normalized_field:
        raise ValueError("表达式字段名不能为空。")
    return [as_text(row.get(normalized_field)) for row in rows if as_text(row.get(normalized_field))]


def evaluate_expression(
    expression_text: str,
    rows: List[Dict[str, str]],
    first_row: Dict[str, str],
) -> Any:
    normalized_expression = as_text(expression_text)
    if not normalized_expression:
        return ""

    def fn_sum(field_name: str) -> float:
        values = expression_values(rows, field_name)
        return sum(to_number(value, as_text(field_name)) for value in values) if values else 0.0

    def fn_avg(field_name: str) -> float:
        values = expression_values(rows, field_name)
        if not values:
            return 0.0
        return fn_sum(field_name) / len(values)

    def fn_first(field_name: str) -> str:
        normalized_field = as_text(field_name)
        if not normalized_field:
            raise ValueError("first() 缺少字段名。")
        return as_text(first_row.get(normalized_field))

    def fn_num(field_name: str) -> float:
        normalized_field = as_text(field_name)
        if not normalized_field:
            raise ValueError("num() 缺少字段名。")
        return to_number(first_row.get(normalized_field), normalized_field)

    def fn_join(field_name: str, delimiter: str = "\n") -> str:
        values = expression_values(rows, field_name)
        return as_text(delimiter).join(values)

    def fn_join_unique(field_name: str, delimiter: str = "\n") -> str:
        values = expression_values(rows, field_name)
        unique_values: List[str] = []
        seen = set()
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            unique_values.append(value)
        return as_text(delimiter).join(unique_values)

    def fn_count(field_name: str = "") -> float:
        normalized_field = as_text(field_name)
        if not normalized_field:
            return float(len(rows))
        return float(len(expression_values(rows, normalized_field)))

    def fn_count_non_empty(field_name: str) -> float:
        return fn_count(field_name)

    functions: Dict[str, Callable[..., Any]] = {
        "sum": fn_sum,
        "avg": fn_avg,
        "first": fn_first,
        "num": fn_num,
        "join": fn_join,
        "join_unique": fn_join_unique,
        "count": fn_count,
        "count_non_empty": fn_count_non_empty,
    }

    def eval_node(node: ast.AST) -> Any:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (str, int, float, bool)) or node.value is None:
                return node.value
            raise ValueError("表达式包含不支持的常量类型。")

        if isinstance(node, ast.BinOp):
            left = eval_node(node.left)
            right = eval_node(node.right)
            if isinstance(node.op, ast.Add):
                if isinstance(left, str) or isinstance(right, str):
                    return f"{as_text(left)}{as_text(right)}"
                return to_number(left, "表达式") + to_number(right, "表达式")
            if isinstance(node.op, ast.Sub):
                return to_number(left, "表达式") - to_number(right, "表达式")
            if isinstance(node.op, ast.Mult):
                return to_number(left, "表达式") * to_number(right, "表达式")
            if isinstance(node.op, ast.Div):
                divisor = to_number(right, "表达式")
                if abs(divisor) < 1e-9:
                    raise ValueError("表达式执行除法时分母为 0。")
                return to_number(left, "表达式") / divisor
            raise ValueError("表达式仅支持 + - * / 运算。")

        if isinstance(node, ast.UnaryOp):
            operand = eval_node(node.operand)
            if isinstance(node.op, ast.USub):
                return -to_number(operand, "表达式")
            if isinstance(node.op, ast.UAdd):
                return to_number(operand, "表达式")
            raise ValueError("表达式仅支持一元 + 或 -。")

        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name):
                raise ValueError("表达式函数调用格式无效。")
            function_name = node.func.id
            function = functions.get(function_name)
            if function is None:
                raise ValueError(f"表达式函数不受支持：{function_name}")
            if node.keywords:
                raise ValueError("表达式暂不支持关键字参数。")
            args = [eval_node(arg) for arg in node.args]
            return function(*args)

        raise ValueError("表达式包含不受支持的语法。")

    try:
        expression = ast.parse(normalized_expression, mode="eval")
    except SyntaxError as error:
        raise ValueError(f"表达式语法错误：{normalized_expression}") from error

    try:
        return eval_node(expression.body)
    except TypeError as error:
        raise ValueError(f"表达式参数错误：{normalized_expression}") from error


def normalize_expression_result(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return format_number(float(value))
    return as_text(value)

