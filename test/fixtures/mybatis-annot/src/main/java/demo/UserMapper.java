package demo;

import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Result;
import org.apache.ibatis.annotations.Results;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * 血缘夹具：表名只能来自 SQL 语句，不能来自"文件里出现过的字符串"。
 *
 * 这个文件里故意埋了四类干扰，全部都**不是**表：
 *   1. @Param("appid") / @Param("cpu") —— 参数名
 *   2. @Result(column = "cpu_usage") —— 结果列名
 *   3. // 注释里的 @Select("... from ghost_table") —— 注释掉的 SQL
 *   4. @Select 之外的方法体字符串 "query from monitor" —— 日志文本
 * 旧实现把整个文件的所有字符串拼起来扫 from/join/update，四类全中
 * （TDC 实测 112 个"表"里 25 个是这样的假阳性，占 22%）。
 */
public interface UserMapper {

  @Results({
      @Result(property = "cpu", column = "cpu_usage")
  })
  @Select("select id, user_name from td_user where appid = #{appid} and cpu > #{cpu}")
  Object findByApp(@Param("appid") String appid, @Param("cpu") Integer cpu);

  // 注释掉的语句不算数：@Select("select * from ghost_table")
  @Select("select * from " +
      "td_order where update_time > #{t}")
  Object findOrders(@Param("t") String t);

  @Update("update td_user set update_time = now() where id = #{id}")
  int touch(@Param("id") Long id);

  default void logSample() {
    System.out.println("query from monitor");
  }
}
