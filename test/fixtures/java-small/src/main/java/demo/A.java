package demo;

import com.fake.thirdparty.Util;
import demo.B;
import other.B;

public class A {
  private final B b = new B();
  private final other.B ob = new other.B();

  public String name() {
    return b.name() + Util.stamp() + ob.scope();
  }
}
