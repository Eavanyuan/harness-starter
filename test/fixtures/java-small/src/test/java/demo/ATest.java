package demo;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class ATest {
  @Test
  void nameComesFromB() {
    assertEquals("b", new A().name());
  }
}
