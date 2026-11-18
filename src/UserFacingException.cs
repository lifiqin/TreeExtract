using System;

namespace TreeExtractor
{
    // 预期的业务错误携带可直接显示的上下文；内部异常仍可用于本地诊断。
    internal sealed class UserFacingException : Exception
    {
        internal UserFacingException(string message) : base(message) { }
        internal UserFacingException(string message, Exception inner) : base(message, inner) { }
    }
}
