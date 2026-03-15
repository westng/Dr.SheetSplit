#!/usr/bin/env python3
import json
import sys

from engine.common import as_text
from engine.runner import run


def main() -> int:
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            raise ValueError("处理引擎未收到输入数据。")
        payload = json.loads(raw)
        result = run(payload)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        sys.stderr.write(as_text(error) or "处理引擎执行失败。")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
