"""Make database values JSON-safe."""

import math
import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

MAX_BINARY_BYTES = 100
# Decimals with more significant digits than a float can hold are returned as strings.
MAX_FLOAT_DIGITS = 15


def to_json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)  # NaN / Infinity aren't JSON
    if isinstance(value, Decimal):
        if not value.is_finite():
            return str(value)
        if value == value.to_integral_value() and abs(value) < 2**53:
            return int(value)
        if len(value.as_tuple().digits) <= MAX_FLOAT_DIGITS:
            return float(value)
        return str(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, timedelta):
        return str(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        text = "0x" + data[:MAX_BINARY_BYTES].hex()
        return text + "…" if len(data) > MAX_BINARY_BYTES else text
    if isinstance(value, dict):
        return {str(k): to_json_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_json_value(v) for v in value]
    return str(value)  # ranges, IP addresses, intervals, ...
