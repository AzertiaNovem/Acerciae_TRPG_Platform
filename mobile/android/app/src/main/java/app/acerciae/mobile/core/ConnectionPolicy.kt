package app.acerciae.mobile.core
import java.io.*
import java.net.*
import javax.net.ssl.SSLException
object ConnectionPolicy {
    fun invalidatesSession(error: Exception): Boolean = error is BackendException && error.apiResponse && error.status == 401
    fun retry(error: IOException): Boolean = when(error) {
        is BackendException -> error.status in listOf(408,502,503,504,520,522,523,524)
        is SSLException, is ProtocolException -> false
        is SocketTimeoutException, is SocketException, is UnknownHostException, is EOFException -> true
        else -> false
    }
    fun message(error: Exception): String = when(error) {
        is BackendException, is InvalidBackendResponse -> error.message.orEmpty()
        is SocketTimeoutException -> "连接超时，正在等待重试"
        is UnknownHostException, is ConnectException -> "暂时无法连接服务器，请检查网络或代理设置"
        is SSLException -> "无法建立安全连接，请检查设备时间或网络代理"
        is SocketException, is EOFException -> "网络连接中断，正在等待重试"
        else -> "连接失败，请重试"
    }
}
